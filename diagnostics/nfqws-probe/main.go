package main

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptrace"
	"net/url"
	"os"
	"sync"
	"syscall"
	"time"

	quic "github.com/quic-go/quic-go"
	"github.com/quic-go/quic-go/http3"
)

var probeInterface string

type result struct {
	ErrorStage   string   `json:"errorStage,omitempty"`
	RemoteIP     string   `json:"remoteIp,omitempty"`
	DNSAddresses []string `json:"dnsAddresses,omitempty"`
	Interface    string   `json:"interface,omitempty"`
	Protocol     string   `json:"protocol"`
	URL          string   `json:"url"`
	OK           bool     `json:"ok"`
	Status       int      `json:"status,omitempty"`
	Error        string   `json:"error,omitempty"`
	ElapsedMs    int64    `json:"elapsedMs"`
}

func main() {
	flag.StringVar(&probeInterface, "interface", "", "bind diagnostic sockets to this WAN interface")
	protocol := flag.String("protocol", "tcp", "tcp, h3, both or connect (TCP handshake only)")
	target := flag.String("url", "", "HTTPS URL to check")
	mark := flag.Int("mark", 833, "Linux socket mark")
	seconds := flag.Int("timeout", 5, "timeout per request in seconds (2-15)")
	version := flag.Bool("version", false, "print probe version")
	flag.Parse()
	if *version {
		fmt.Println("xkeen-nfqws-probe 4")
		return
	}
	if *seconds < 2 || *seconds > 15 {
		fmt.Fprintln(os.Stderr, "timeout must be 2-15")
		os.Exit(2)
	}
	if *protocol == "both" {
		results := make(chan result, 2)
		for _, p := range []string{"tcp", "h3"} {
			go func(p string) { results <- check(p, *target, *mark, *seconds) }(p)
		}
		for i := 0; i < 2; i++ {
			emit(<-results)
		}
	} else {
		emit(check(*protocol, *target, *mark, *seconds))
	}
}

func check(p, u string, m, seconds int) (out result) {
	protocol, target, mark := &p, &u, &m
	out = result{Protocol: *protocol, URL: *target, Interface: probeInterface}
	started := time.Now()
	defer func() { out.ElapsedMs = time.Since(started).Milliseconds() }()
	if *protocol != "tcp" && *protocol != "h3" && *protocol != "connect" {
		out.Error = "unknown protocol"
		return out
	}
	parsed, err := url.Parse(*target)
	if err != nil || (parsed.Scheme != "https" && parsed.Scheme != "http") || parsed.Hostname() == "" || parsed.Port() != "" {
		out.Error = "HTTP(S) URL without custom port required"
		return out
	}
	if *mark < 0 || *mark > 65535 {
		out.Error = "invalid mark"
		return out
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(seconds)*time.Second)
	defer cancel()
	var traceMu sync.Mutex
	stage := "dns"
	remoteIP := ""
	var dnsAddresses []string
	setStage := func(next string) { traceMu.Lock(); stage = next; traceMu.Unlock() }
	defer func() {
		traceMu.Lock()
		defer traceMu.Unlock()
		out.RemoteIP = remoteIP
		out.DNSAddresses = append([]string(nil), dnsAddresses...)
		if out.Error != "" {
			out.ErrorStage = stage
		}
	}()
	ctx = httptrace.WithClientTrace(ctx, &httptrace.ClientTrace{
		DNSStart: func(httptrace.DNSStartInfo) { setStage("dns") },
		DNSDone: func(info httptrace.DNSDoneInfo) {
			traceMu.Lock()
			for _, ip := range info.Addrs {
				dnsAddresses = append(dnsAddresses, ip.IP.String())
			}
			traceMu.Unlock()
		},
		ConnectStart: func(_, addr string) {
			traceMu.Lock()
			stage = "tcp-connect"
			remoteIP, _, _ = net.SplitHostPort(addr)
			traceMu.Unlock()
		},
		TLSHandshakeStart: func() { setStage("tls-handshake") },
		TLSHandshakeDone: func(_ tls.ConnectionState, err error) {
			if err == nil {
				setStage("http-response")
			}
		},
		GotFirstResponseByte: func() { setStage("http-body") },
	})
	control := func(_, _ string, c syscall.RawConn) error {
		var setErr error
		if err := c.Control(func(fd uintptr) {
			setErr = syscall.SetsockoptInt(int(fd), syscall.SOL_SOCKET, syscall.SO_MARK, *mark)
			if setErr == nil && probeInterface != "" {
				setErr = syscall.SetsockoptString(int(fd), syscall.SOL_SOCKET, syscall.SO_BINDTODEVICE, probeInterface)
			}
		}); err != nil {
			return err
		}
		return setErr
	}
	if *protocol == "connect" {
		port := "443"
		if parsed.Scheme == "http" {
			port = "80"
		}
		dialer := &net.Dialer{Timeout: time.Duration(seconds) * time.Second, Control: control}
		conn, err := dialer.DialContext(ctx, "tcp4", net.JoinHostPort(parsed.Hostname(), port))
		if err != nil {
			out.Error = err.Error()
			return out
		}
		traceMu.Lock()
		remoteIP, _, _ = net.SplitHostPort(conn.RemoteAddr().String())
		traceMu.Unlock()
		_ = conn.Close()
		out.OK = true
		return out
	}
	var transport http.RoundTripper
	var closeTransport func()
	if *protocol == "tcp" {
		dialer := &net.Dialer{Timeout: time.Duration(seconds) * time.Second, Control: control}
		t := &http.Transport{DialContext: func(ctx context.Context, _, addr string) (net.Conn, error) {
			return dialer.DialContext(ctx, "tcp4", addr)
		}, TLSHandshakeTimeout: time.Duration(seconds) * time.Second, ForceAttemptHTTP2: true, DisableKeepAlives: true}
		transport = t
		closeTransport = t.CloseIdleConnections
	} else {
		listen := net.ListenConfig{Control: control}
		packet, err := listen.ListenPacket(ctx, "udp4", ":0")
		if err != nil {
			out.Error = err.Error()
			return out
		}
		t := &http3.Transport{Dial: func(dialCtx context.Context, addr string, tlsCfg *tls.Config, cfg *quic.Config) (*quic.Conn, error) {
			host, port, err := net.SplitHostPort(addr)
			if err != nil {
				return nil, err
			}
			ips, err := net.DefaultResolver.LookupIPAddr(dialCtx, host)
			if err != nil {
				return nil, err
			}
			var remote *net.UDPAddr
			for _, ip := range ips {
				if ip.IP.To4() != nil {
					remote, err = net.ResolveUDPAddr("udp4", net.JoinHostPort(ip.IP.String(), port))
					break
				}
			}
			if err != nil {
				return nil, err
			}
			if remote == nil {
				return nil, errors.New("no IPv4 address")
			}
			traceMu.Lock()
			remoteIP = remote.IP.String()
			stage = "quic-handshake"
			traceMu.Unlock()
			return quic.DialEarly(dialCtx, packet, remote, tlsCfg, cfg)
		}}
		transport = t
		closeTransport = func() { _ = t.Close(); _ = packet.Close() }
	}
	defer closeTransport()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, *target, nil)
	if err != nil {
		out.Error = err.Error()
		return out
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 XKeen-Probe/1.0")
	response, err := transport.RoundTrip(req)
	if err != nil {
		out.Error = err.Error()
		return out
	}
	defer response.Body.Close()
	_, _ = io.CopyN(io.Discard, response.Body, 128)
	out.Status = response.StatusCode
	if *protocol == "h3" && response.ProtoMajor != 3 {
		out.Error = "HTTP/3 was not negotiated"
	} else if response.StatusCode >= 500 {
		out.Error = fmt.Sprintf("server returned %d", response.StatusCode)
	} else {
		out.OK = true
	}
	return out
}

func emit(out result) {
	if out.Error != "" && len(out.Error) > 240 {
		out.Error = out.Error[:240]
	}
	if out.Error == "" && !out.OK {
		out.Error = errors.New("no response").Error()
	}
	_ = json.NewEncoder(os.Stdout).Encode(out)
}
