#include <stddef.h>
int cr_clipboard_available(void);
int cr_clipboard_read(const char *name, int *kind, void **data, size_t *length);
int cr_clipboard_write(const char *name, int kind, const void *data, size_t length);
int cr_clipboard_version(const char *name, long long *version);
int cr_clipboard_write_if_version(const char *name, int kind, const void *data, size_t length, long long version);
