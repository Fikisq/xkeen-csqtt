/* Pass a Linux TUN descriptor to the unmodified amurcanov CSQTT 2.1.9 client. */
#define _GNU_SOURCE
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <linux/if.h>
#include <linux/if_tun.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <time.h>
#include <unistd.h>
#include <sys/wait.h>

static int run_ip(const char *a, const char *b, const char *c,
                  const char *d, const char *e, const char *f) {
    pid_t pid = fork();
    if (pid < 0) return -1;
    if (pid == 0) {
        char *const args[] = {"ip", (char *)a, (char *)b, (char *)c,
                              (char *)d, (char *)e, (char *)f, NULL};
        execv("/opt/sbin/ip", args);
        _exit(127);
    }
    int status;
    return waitpid(pid, &status, 0) == pid && WIFEXITED(status) && WEXITSTATUS(status) == 0 ? 0 : -1;
}

int main(int argc, char **argv) {
    if (argc != 4 || strlen(argv[1]) == 0 || strlen(argv[1]) >= IFNAMSIZ ||
        strlen(argv[2]) == 0 || strlen(argv[2]) >= sizeof(((struct sockaddr_un *)0)->sun_path) - 1) {
        fprintf(stderr, "usage: csqtt-tun-fd IFACE ABSTRACT_SOCKET LOG\n");
        return 2;
    }
    int fd = open("/dev/net/tun", O_RDWR | O_CLOEXEC | O_NONBLOCK);
    if (fd < 0) { perror("open TUN"); return 1; }
    struct ifreq request = {0};
    strncpy(request.ifr_name, argv[1], IFNAMSIZ - 1);
    request.ifr_flags = IFF_TUN | IFF_NO_PI;
    if (ioctl(fd, TUNSETIFF, &request) < 0) { perror("TUNSETIFF"); return 1; }

    if (run_ip("link", "set", "dev", argv[1], "mtu", "1300") != 0 ||
        run_ip("link", "set", "dev", argv[1], "up", NULL) != 0) {
        fprintf(stderr, "cannot configure TUN link\n"); return 1;
    }
    FILE *log = fopen(argv[3], "r");
    if (!log) { perror("open CSQTT log"); return 1; }
    fseek(log, 0, SEEK_END);
    int sock = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
    if (sock < 0) { perror("socket"); return 1; }
    struct timeval io_timeout = {.tv_sec = 15, .tv_usec = 0};
    if (setsockopt(sock, SOL_SOCKET, SO_RCVTIMEO, &io_timeout, sizeof(io_timeout)) != 0 ||
        setsockopt(sock, SOL_SOCKET, SO_SNDTIMEO, &io_timeout, sizeof(io_timeout)) != 0) {
        perror("set CSQTT TUN socket timeout"); return 1;
    }
    struct sockaddr_un addr = {.sun_family = AF_UNIX};
    size_t name_len = strlen(argv[2]);
    memcpy(addr.sun_path + 1, argv[2], name_len);
    socklen_t addr_len = (socklen_t)(offsetof(struct sockaddr_un, sun_path) + name_len + 1);
    time_t deadline = time(NULL) + 60;
    while (connect(sock, (struct sockaddr *)&addr, addr_len) < 0) {
        if (time(NULL) >= deadline) { perror("connect CSQTT TUN socket"); return 1; }
        usleep(100000);
    }
    char marker = 1;
    struct iovec iov = {.iov_base = &marker, .iov_len = 1};
    char control[CMSG_SPACE(sizeof(fd))] = {0};
    struct msghdr msg = {.msg_iov = &iov, .msg_iovlen = 1,
                         .msg_control = control, .msg_controllen = sizeof(control)};
    struct cmsghdr *cmsg = CMSG_FIRSTHDR(&msg);
    cmsg->cmsg_level = SOL_SOCKET;
    cmsg->cmsg_type = SCM_RIGHTS;
    cmsg->cmsg_len = CMSG_LEN(sizeof(fd));
    memcpy(CMSG_DATA(cmsg), &fd, sizeof(fd));
    if (sendmsg(sock, &msg, MSG_NOSIGNAL) != 1 || recv(sock, &marker, 1, 0) != 1) {
        perror("pass TUN FD"); return 1;
    }
    close(sock);
    close(fd);
    fprintf(stderr, "[TUN] csqtt0 descriptor passed to CSQTT 2.1.9\n");

    deadline = time(NULL) + 180;
    char line[4096];
    while (time(NULL) < deadline) {
        if (fgets(line, sizeof(line), log)) {
            char *field = strstr(line, "Tunnel IP: ");
            if (!field) continue;
            field += strlen("Tunnel IP: ");
            char ip[INET_ADDRSTRLEN] = {0};
            size_t n = strcspn(field, "/ \r\n");
            if (n == 0 || n >= sizeof(ip)) continue;
            memcpy(ip, field, n);
            struct in_addr parsed;
            if (inet_pton(AF_INET, ip, &parsed) != 1) continue;
            char address[INET_ADDRSTRLEN + 3];
            snprintf(address, sizeof(address), "%s/32", ip);
            if (run_ip("addr", "add", address, "dev", argv[1], NULL) == 0) {
                fprintf(stderr, "[TUN] %s configured\n", argv[1]);
                fclose(log);
                return 0;
            }
            fprintf(stderr, "[TUN] cannot assign address to %s\n", argv[1]);
            fclose(log);
            return 1;
        }
        clearerr(log);
        usleep(100000);
    }
    fprintf(stderr, "[TUN] timeout waiting for CSQTT tunnel address\n");
    fclose(log);
    return 1;
}
