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
    "net/url"
    "os"
    "syscall"
    "time"

    quic "github.com/quic-go/quic-go"
    "github.com/quic-go/quic-go/http3"
)

type result struct {
    Protocol string `json:"protocol"`
    URL string `json:"url"`
    OK bool `json:"ok"`
    Status int `json:"status,omitempty"`
    Error string `json:"error,omitempty"`
}

func main() {
    protocol := flag.String("protocol", "tcp", "tcp or h3")
    target := flag.String("url", "", "HTTPS URL to check")
    mark := flag.Int("mark", 833, "Linux socket mark")
    flag.Parse()
    out := result{Protocol: *protocol, URL: *target}
    if *protocol != "tcp" && *protocol != "h3" { out.Error = "unknown protocol"; emit(out); return }
    parsed, err := url.Parse(*target)
    if err != nil || parsed.Scheme != "https" || parsed.Hostname() == "" || parsed.Port() != "" {
        out.Error = "HTTPS URL without custom port required"; emit(out); return
    }
    if *mark < 0 || *mark > 65535 { out.Error = "invalid mark"; emit(out); return }
    ctx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
    defer cancel()
    control := func(_, _ string, c syscall.RawConn) error {
        var setErr error
        if err := c.Control(func(fd uintptr) { setErr = syscall.SetsockoptInt(int(fd), syscall.SOL_SOCKET, syscall.SO_MARK, *mark) }); err != nil { return err }
        return setErr
    }
    var transport http.RoundTripper
    var closeTransport func()
    if *protocol == "tcp" {
        dialer := &net.Dialer{Timeout: 7*time.Second, Control: control}
        t := &http.Transport{DialContext: dialer.DialContext, TLSHandshakeTimeout: 7*time.Second, ForceAttemptHTTP2: true, DisableKeepAlives: true}
        transport = t
        closeTransport = t.CloseIdleConnections
    } else {
        listen := net.ListenConfig{Control: control}
        packet, err := listen.ListenPacket(ctx, "udp4", ":0")
        if err != nil { out.Error = err.Error(); emit(out); return }
        t := &http3.Transport{Dial: func(dialCtx context.Context, addr string, tlsCfg *tls.Config, cfg *quic.Config) (*quic.Conn, error) {
            remote, err := net.ResolveUDPAddr("udp4", addr)
            if err != nil { return nil, err }
            return quic.DialEarly(dialCtx, packet, remote, tlsCfg, cfg)
        }}
        transport = t
        closeTransport = func() { _ = t.Close(); _ = packet.Close() }
    }
    defer closeTransport()
    req, err := http.NewRequestWithContext(ctx, http.MethodGet, *target, nil)
    if err != nil { out.Error = err.Error(); emit(out); return }
    req.Header.Set("User-Agent", "Mozilla/5.0 XKeen-Probe/1.0")
    response, err := transport.RoundTrip(req)
    if err != nil { out.Error = err.Error(); emit(out); return }
    defer response.Body.Close()
    _, _ = io.CopyN(io.Discard, response.Body, 128)
    out.Status = response.StatusCode
    if *protocol == "h3" && response.ProtoMajor != 3 { out.Error = "HTTP/3 was not negotiated" } else if response.StatusCode >= 500 { out.Error = fmt.Sprintf("server returned %d", response.StatusCode) } else { out.OK = true }
    emit(out)
}

func emit(out result) {
    if out.Error != "" && len(out.Error) > 240 { out.Error = out.Error[:240] }
    if out.Error == "" && !out.OK { out.Error = errors.New("no response").Error() }
    _ = json.NewEncoder(os.Stdout).Encode(out)
}
