// chronicle-spawn：用私有 API responsibility_spawnattrs_setdisclaim 让被 spawn 的采集守护
// 成为「自己的 TCC 责任进程」，这样用户在辅助功能里给 Chronicle Helper.app 的授权才会生效，
// 而不是被父进程（node daemon 管理器 / launchd）的授权状态连坐。
//
// 用法：chronicle-spawn <可执行文件> [args...]
// 依赖：macOS（symbol 不存在时退化为普通 posix_spawn，不改变现有行为）。
#include <dlfcn.h>
#include <errno.h>
#include <signal.h>
#include <spawn.h>
#include <stdio.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

extern char **environ;

typedef void (*disclaim_fn)(posix_spawnattr_t *, int);

int main(int argc, char **argv) {
  if (argc < 2) {
    fprintf(stderr, "usage: chronicle-spawn <executable> [args...]\n");
    return 2;
  }

  posix_spawnattr_t attr;
  if (posix_spawnattr_init(&attr) != 0) {
    perror("posix_spawnattr_init");
    return 1;
  }

  void *sym = dlsym(RTLD_DEFAULT, "responsibility_spawnattrs_setdisclaim");
  if (sym != NULL) {
    ((disclaim_fn)sym)(&attr, 1);
  } else {
    fprintf(stderr, "chronicle-spawn: responsibility disclaim unavailable, spawning without it\n");
  }

  pid_t pid = 0;
  int rc = posix_spawn(&pid, argv[1], NULL, &attr, &argv[1], environ);
  posix_spawnattr_destroy(&attr);
  if (rc != 0) {
    fprintf(stderr, "chronicle-spawn: posix_spawn(%s) failed: %s\n", argv[1], strerror(rc));
    return 1;
  }

  int status = 0;
  while (waitpid(pid, &status, 0) < 0) {
    if (errno == EINTR) continue;
    perror("waitpid");
    return 1;
  }
  if (WIFEXITED(status)) return WEXITSTATUS(status);
  if (WIFSIGNALED(status)) {
    int sig = WTERMSIG(status);
    signal(sig, SIG_DFL);
    raise(sig);
    return 1;
  }
  return 1;
}
