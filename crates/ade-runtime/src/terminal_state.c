#include <ghostty/vt.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>

static bool report_size(GhosttyTerminal terminal, void *userdata, GhosttySizeReportSize *size) {
    (void)userdata;
    uint32_t width = 0, height = 0;
    if (ghostty_terminal_get(terminal, GHOSTTY_TERMINAL_DATA_COLS, &size->columns) != GHOSTTY_SUCCESS ||
        ghostty_terminal_get(terminal, GHOSTTY_TERMINAL_DATA_ROWS, &size->rows) != GHOSTTY_SUCCESS ||
        ghostty_terminal_get(terminal, GHOSTTY_TERMINAL_DATA_WIDTH_PX, &width) != GHOSTTY_SUCCESS ||
        ghostty_terminal_get(terminal, GHOSTTY_TERMINAL_DATA_HEIGHT_PX, &height) != GHOSTTY_SUCCESS) return false;
    size->cell_width = width / size->columns;
    size->cell_height = height / size->rows;
    return true;
}
static bool report_device(GhosttyTerminal terminal, void *userdata, GhosttyDeviceAttributes *attributes) {
    (void)terminal; (void)userdata;
    // Match the embedded renderer's VT220/color capabilities, without claiming
    // escape-sequence clipboard support, which the daemon explicitly denies.
    *attributes = (GhosttyDeviceAttributes){
        .primary = { .conformance_level = GHOSTTY_DA_CONFORMANCE_VT220,
            .features = { GHOSTTY_DA_FEATURE_ANSI_COLOR }, .num_features = 1 },
        .secondary = { .device_type = GHOSTTY_DA_DEVICE_TYPE_VT220, .firmware_version = 10 }
    };
    return true;
}
static bool report_scheme(GhosttyTerminal terminal, void *userdata, GhosttyColorScheme *scheme) {
    (void)terminal; (void)userdata;
    *scheme = GHOSTTY_COLOR_SCHEME_DARK;
    return true;
}

void *ade_vt_new(uint16_t cols, uint16_t rows) {
    GhosttyTerminal terminal = NULL;
    if (ghostty_terminal_new(NULL, &terminal, cols, rows) != GHOSTTY_SUCCESS) return NULL;
    size_t history = 4 * 1024 * 1024;
    size_t continuation = 1024 * 1024;
    if (ghostty_terminal_set(terminal, GHOSTTY_TERMINAL_OPT_SCROLLBACK_MAX_BYTES, &history) != GHOSTTY_SUCCESS ||
        ghostty_terminal_set(terminal, GHOSTTY_TERMINAL_OPT_CONTINUATION_MAX_BYTES, &continuation) != GHOSTTY_SUCCESS) {
        ghostty_terminal_free(terminal);
        return NULL;
    }
    return terminal;
}

void ade_vt_free(void *terminal) { ghostty_terminal_free(terminal); }
int ade_vt_reply_callback(void *terminal, GhosttyTerminalWritePtyFn callback, void *userdata) {
    GhosttyResult result = ghostty_terminal_set(terminal, GHOSTTY_TERMINAL_OPT_USERDATA, userdata);
    if (result != GHOSTTY_SUCCESS) return result;
    result = ghostty_terminal_set(terminal, GHOSTTY_TERMINAL_OPT_SIZE, (const void *)report_size);
    if (result != GHOSTTY_SUCCESS) return result;
    result = ghostty_terminal_set(terminal, GHOSTTY_TERMINAL_OPT_DEVICE_ATTRIBUTES, (const void *)report_device);
    if (result != GHOSTTY_SUCCESS) return result;
    result = ghostty_terminal_set(terminal, GHOSTTY_TERMINAL_OPT_COLOR_SCHEME, (const void *)report_scheme);
    if (result != GHOSTTY_SUCCESS) return result;
    return ghostty_terminal_set(terminal, GHOSTTY_TERMINAL_OPT_WRITE_PTY, (const void *)callback);
}
void ade_vt_write(void *terminal, const uint8_t *bytes, size_t len) {
    ghostty_terminal_vt_write(terminal, bytes, len);
}
int ade_vt_resize(void *terminal, uint16_t cols, uint16_t rows, uint32_t cell_width, uint32_t cell_height) {
    return ghostty_terminal_resize(terminal, cols, rows, cell_width, cell_height);
}

// Fixed-layout inspection is also used by recovery tests, independent of VT text.
int ade_vt_info(void *terminal, uint16_t *values) {
    const GhosttyTerminalData fields[] = { GHOSTTY_TERMINAL_DATA_COLS, GHOSTTY_TERMINAL_DATA_ROWS,
        GHOSTTY_TERMINAL_DATA_CURSOR_X, GHOSTTY_TERMINAL_DATA_CURSOR_Y };
    for (size_t i = 0; i < 4; i++) {
        if (ghostty_terminal_get(terminal, fields[i], &values[i]) != GHOSTTY_SUCCESS) return -1;
    }
    GhosttyTerminalScreen screen;
    bool visible, ground;
    if (ghostty_terminal_get(terminal, GHOSTTY_TERMINAL_DATA_ACTIVE_SCREEN, &screen) != GHOSTTY_SUCCESS ||
        ghostty_terminal_get(terminal, GHOSTTY_TERMINAL_DATA_CURSOR_VISIBLE, &visible) != GHOSTTY_SUCCESS ||
        ghostty_terminal_get(terminal, GHOSTTY_TERMINAL_DATA_VT_GROUND, &ground) != GHOSTTY_SUCCESS) return -1;
    values[4] = screen == GHOSTTY_TERMINAL_SCREEN_ALTERNATE;
    values[5] = visible;
    values[6] = ground;
    GhosttyTerminalModeConfig mode = { .mode = GHOSTTY_MODE_BRACKETED_PASTE };
    if (ghostty_terminal_get(terminal, GHOSTTY_TERMINAL_DATA_MODE, &mode) != GHOSTTY_SUCCESS) return -1;
    values[7] = mode.value;
    mode.mode = GHOSTTY_MODE_DECCKM;
    if (ghostty_terminal_get(terminal, GHOSTTY_TERMINAL_DATA_MODE, &mode) != GHOSTTY_SUCCESS) return -1;
    values[8] = mode.value;
    return 0;
}

int ade_vt_snapshot(void *terminal, uint8_t **bytes, size_t *len, bool plain) {
    GhosttyFormatterTerminalOptions options = {
        .size = sizeof(options),
        .emit = plain ? GHOSTTY_FORMATTER_FORMAT_PLAIN : GHOSTTY_FORMATTER_FORMAT_VT,
        .unwrap = false,
        .trim = true,
        .extra = {
            .size = sizeof(GhosttyFormatterTerminalExtra),
            .palette = !plain, .modes = !plain, .scrolling_region = !plain,
            .tabstops = !plain, .pwd = false, .keyboard = !plain,
            .screen = {
                .size = sizeof(GhosttyFormatterScreenExtra),
                .cursor = !plain, .style = !plain, .hyperlink = !plain,
                .protection = !plain, .kitty_keyboard = !plain, .charsets = !plain
            }
        }
    };
    GhosttyFormatter formatter = NULL;
    GhosttyResult result = ghostty_formatter_terminal_new(NULL, &formatter, terminal, options);
    if (result != GHOSTTY_SUCCESS) return result;
    result = ghostty_formatter_format_alloc(formatter, NULL, bytes, len);
    ghostty_formatter_free(formatter);
    return result;
}
void ade_vt_buffer_free(uint8_t *bytes, size_t len) { ghostty_free(NULL, bytes, len); }

int ade_vt_encode(void *terminal, uint8_t **bytes, size_t *len) {
    return ghostty_snapshot_encode_alloc(terminal, NULL, bytes, len);
}

int ade_vt_decode(const uint8_t *bytes, size_t len, void **terminal) {
    *terminal = NULL;
    GhosttySnapshotDecoder decoder = NULL;
    GhosttyResult result = ghostty_snapshot_decoder_new_buf(NULL, &decoder, bytes, len);
    if (result != GHOSTTY_SUCCESS) return result;
    size_t continuation = 1024 * 1024;
    bool retain = true;
    result = ghostty_snapshot_decoder_set(decoder, GHOSTTY_SNAPSHOT_DECODER_OPT_MAX_CONTINUATION_BYTES, &continuation);
    if (result == GHOSTTY_SUCCESS)
        result = ghostty_snapshot_decoder_set(decoder, GHOSTTY_SNAPSHOT_DECODER_OPT_RETAIN_CONTINUATION, &retain);
    if (result == GHOSTTY_SUCCESS)
        result = ghostty_snapshot_decoder_decode(decoder, (GhosttyTerminal *)terminal);
    ghostty_snapshot_decoder_free(decoder);
    return result;
}
