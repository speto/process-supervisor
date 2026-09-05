#include <errno.h>
#include <inttypes.h>
#include <libproc.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/proc_info.h>

static int parse_pid(const char *value, pid_t *pid) {
  char *end = NULL;
  errno = 0;
  long parsed = strtol(value, &end, 10);
  if (errno != 0 || end == value || *end != '\0' || parsed <= 0 || parsed > INT32_MAX) {
    return -1;
  }
  *pid = (pid_t)parsed;
  return 0;
}

int main(int argc, char **argv) {
  if (argc < 2) {
    fprintf(stderr, "usage: darwin-process-info <pid> [pid ...]\n");
    return 64;
  }

  for (int index = 1; index < argc; index += 1) {
    pid_t pid = 0;
    if (parse_pid(argv[index], &pid) != 0) {
      fprintf(stderr, "invalid pid: %s\n", argv[index]);
      return 64;
    }

    struct proc_bsdinfo info = {0};
    errno = 0;
    int bytes = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, sizeof(info));
    if (bytes <= 0) {
      if (errno == ESRCH || errno == ENOENT || errno == 0) {
        continue;
      }
      fprintf(stderr, "proc_pidinfo(%d) failed: errno=%d\n", pid, errno);
      return 1;
    }
    if ((size_t)bytes < PROC_PIDTBSDINFO_SIZE || info.pbi_pid != (uint32_t)pid || info.pbi_pgid == 0) {
      fprintf(stderr, "proc_pidinfo(%d) returned inconsistent process identity\n", pid);
      return 1;
    }

    printf(
      "%d %u %" PRIu64 " %" PRIu64 "\n",
      pid,
      info.pbi_pgid,
      info.pbi_start_tvsec,
      info.pbi_start_tvusec
    );
  }

  return 0;
}
