#include <stddef.h>
int cr_clipboard_available(void);
int cr_clipboard_read(const char *name, int *kind, void **data, size_t *length);
int cr_clipboard_write(const char *name, int kind, const void *data, size_t length);
