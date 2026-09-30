// C2 #209 instrument: LD_PRELOAD shim that logs every exec*/posix_spawn*/connect*/getaddrinfo made by a process
// tree (children inherit LD_PRELOAD). One O_APPEND write per line to $EXECLOG_FILE (atomic < PIPE_BUF).
//   EXEC <t_ms> <pid> <ppid> <argv...>      CONNECT <t_ms> <pid> <family> <addr:port|path>      DNS <t_ms> <pid> <host>
// Build: gcc -shared -fPIC -O2 -o execlog.so execlog.c -ldl   (see build.sh)
#define _GNU_SOURCE
#include <dlfcn.h>
#include <fcntl.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>
#include <spawn.h>
#include <netdb.h>
#include <arpa/inet.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <netinet/in.h>

static long now_ms(void) { struct timespec ts; clock_gettime(CLOCK_MONOTONIC, &ts); return ts.tv_sec * 1000L + ts.tv_nsec / 1000000L; }
static void emit(const char *buf, size_t n) {
  const char *f = getenv("EXECLOG_FILE");
  if (!f) return;
  int fd = open(f, O_WRONLY | O_APPEND | O_CREAT | O_CLOEXEC, 0644);
  if (fd < 0) return;
  ssize_t r = write(fd, buf, n); (void)r;
  close(fd);
}
static void log_argv(const char *tag, const char *path, char *const argv[]) {
  char line[3800]; size_t o = 0;
  o += snprintf(line + o, sizeof line - o, "%s %ld %d %d %s", tag, now_ms(), getpid(), getppid(), path ? path : "?");
  if (argv) for (int i = 0; argv[i] && o < sizeof line - 200; i++) {
    const char *a = argv[i]; size_t L = strlen(a); if (L > 160) L = 160;
    o += snprintf(line + o, sizeof line - o, " %.*s", (int)L, a);
  }
  line[o++] = '\n'; emit(line, o);
}
#define REAL(name, type) static type real = NULL; if (!real) real = (type)dlsym(RTLD_NEXT, name)

int execve(const char *p, char *const a[], char *const e[]) { typedef int (*T)(const char*, char *const[], char *const[]); REAL("execve", T); log_argv("EXEC", p, a); return real(p, a, e); }
int execv(const char *p, char *const a[]) { typedef int (*T)(const char*, char *const[]); REAL("execv", T); log_argv("EXEC", p, a); return real(p, a); }
int execvp(const char *p, char *const a[]) { typedef int (*T)(const char*, char *const[]); REAL("execvp", T); log_argv("EXEC", p, a); return real(p, a); }
int execvpe(const char *p, char *const a[], char *const e[]) { typedef int (*T)(const char*, char *const[], char *const[]); REAL("execvpe", T); log_argv("EXEC", p, a); return real(p, a, e); }
int posix_spawn(pid_t *pid, const char *p, const posix_spawn_file_actions_t *fa, const posix_spawnattr_t *at, char *const a[], char *const e[]) {
  typedef int (*T)(pid_t*, const char*, const posix_spawn_file_actions_t*, const posix_spawnattr_t*, char *const[], char *const[]); REAL("posix_spawn", T); log_argv("EXEC", p, a); return real(pid, p, fa, at, a, e); }
int posix_spawnp(pid_t *pid, const char *p, const posix_spawn_file_actions_t *fa, const posix_spawnattr_t *at, char *const a[], char *const e[]) {
  typedef int (*T)(pid_t*, const char*, const posix_spawn_file_actions_t*, const posix_spawnattr_t*, char *const[], char *const[]); REAL("posix_spawnp", T); log_argv("EXEC", p, a); return real(pid, p, fa, at, a, e); }

int connect(int fd, const struct sockaddr *sa, socklen_t len) {
  typedef int (*T)(int, const struct sockaddr*, socklen_t); REAL("connect", T);
  char line[400]; int o = 0;
  if (sa->sa_family == AF_INET) { const struct sockaddr_in *s = (const void*)sa; char ip[64]; inet_ntop(AF_INET, &s->sin_addr, ip, sizeof ip);
    o = snprintf(line, sizeof line, "CONNECT %ld %d inet %s:%d\n", now_ms(), getpid(), ip, ntohs(s->sin_port)); }
  else if (sa->sa_family == AF_INET6) { const struct sockaddr_in6 *s = (const void*)sa; char ip[80]; inet_ntop(AF_INET6, &s->sin6_addr, ip, sizeof ip);
    o = snprintf(line, sizeof line, "CONNECT %ld %d inet6 [%s]:%d\n", now_ms(), getpid(), ip, ntohs(s->sin6_port)); }
  else if (sa->sa_family == AF_UNIX) { const struct sockaddr_un *s = (const void*)sa;
    o = snprintf(line, sizeof line, "CONNECT %ld %d unix %.100s\n", now_ms(), getpid(), s->sun_path[0] ? s->sun_path : s->sun_path + 1); }
  if (o > 0) emit(line, (size_t)o);
  return real(fd, sa, len);
}
int getaddrinfo(const char *n, const char *s, const struct addrinfo *h, struct addrinfo **r) {
  typedef int (*T)(const char*, const char*, const struct addrinfo*, struct addrinfo**); REAL("getaddrinfo", T);
  char line[300]; int o = snprintf(line, sizeof line, "DNS %ld %d %.200s\n", now_ms(), getpid(), n ? n : "?"); emit(line, (size_t)o);
  return real(n, s, h, r);
}
