#import <AppKit/AppKit.h>
#import <QuartzCore/QuartzCore.h>
#import <Carbon/Carbon.h>
#include <ghostty.h>

// Small AppKit boundary: the surface owns an attach process, never the daemon PTY.
@interface ADETerminalView : NSView <NSTextInputClient>
@property(nonatomic, assign) ghostty_surface_t surface;
@property(nonatomic, strong) NSMutableAttributedString *marked;
@property(nonatomic, strong) NSString *keyText;
@property(nonatomic, assign) BOOL interpreting;
@property(nonatomic, assign) BOOL exited;
- (void)syncActivity;
@end

static ghostty_app_t app;
static ghostty_config_t config;

static ghostty_input_mods_e mods(NSEventModifierFlags flags) {
    unsigned m = 0;
    if (flags & NSEventModifierFlagShift) m |= GHOSTTY_MODS_SHIFT;
    if (flags & NSEventModifierFlagControl) m |= GHOSTTY_MODS_CTRL;
    if (flags & NSEventModifierFlagOption) m |= GHOSTTY_MODS_ALT;
    if (flags & NSEventModifierFlagCommand) m |= GHOSTTY_MODS_SUPER;
    if (flags & NSEventModifierFlagCapsLock) m |= GHOSTTY_MODS_CAPS;
    return m;
}
static void wakeup(void *unused) {
    dispatch_async(dispatch_get_main_queue(), ^{ if (app) ghostty_app_tick(app); });
}
static bool action(ghostty_app_t a, ghostty_target_s target, ghostty_action_s act) {
    if (act.tag == GHOSTTY_ACTION_RENDER && target.tag == GHOSTTY_TARGET_SURFACE) {
        ghostty_surface_draw(target.target.surface);
        return true;
    }
    // Window management and URLs belong to the host, not implicit terminal actions.
    return false;
}
static ghostty_clipboard_read_result_e read_clipboard(void *userdata, ghostty_clipboard_e clipboard,
    void *state, const char *const *mimes, size_t mime_count, bool list) {
    ADETerminalView *view = (__bridge ADETerminalView *)userdata;
    if (list || clipboard != GHOSTTY_CLIPBOARD_STANDARD) return GHOSTTY_CLIPBOARD_READ_UNSUPPORTED;
    bool plain = mime_count == 0;
    for (size_t i = 0; i < mime_count; i++) if (strcmp(mimes[i], "text/plain") == 0) plain = true;
    if (!plain) return GHOSTTY_CLIPBOARD_READ_UNSUPPORTED;
    NSString *text = [[NSPasteboard generalPasteboard] stringForType:NSPasteboardTypeString];
    if (!view.surface) return GHOSTTY_CLIPBOARD_READ_UNAVAILABLE;
    NSData *data = [(text ?: @"") dataUsingEncoding:NSUTF8StringEncoding];
    ghostty_clipboard_content_s item = { .mime = "text/plain", .data = data.bytes, .len = data.length };
    ghostty_clipboard_complete_s complete = { .contents = &item, .contents_len = 1 };
    ghostty_surface_complete_clipboard_request(view.surface, &complete, state);
    return GHOSTTY_CLIPBOARD_READ_STARTED;
}
static void confirm_clipboard(void *userdata, const ghostty_clipboard_confirm_s *contents, void *state, ghostty_clipboard_request_e request) {
    // Reject escape-sequence clipboard reads requiring confirmation in this prototype.
    ADETerminalView *view = (__bridge ADETerminalView *)userdata;
    if (view.surface) ghostty_surface_deny_clipboard_request(view.surface, state);
}
static void write_clipboard(void *userdata, ghostty_clipboard_e clipboard,
                            const ghostty_clipboard_content_s *items, size_t count, bool confirm) {
    if (confirm) return;
    for (size_t i = 0; i < count; i++) {
        if (items[i].mime && strcmp(items[i].mime, "text/plain") == 0 && items[i].data) {
            NSString *text = [[NSString alloc] initWithBytes:items[i].data length:items[i].len encoding:NSUTF8StringEncoding];
            if (text) { [[NSPasteboard generalPasteboard] clearContents];
                [[NSPasteboard generalPasteboard] setString:text forType:NSPasteboardTypeString]; }
            break;
        }
    }
}
static void close_surface(void *userdata, bool alive) {
    ADETerminalView *view = (__bridge ADETerminalView *)userdata;
    view.exited = YES;
}

bool ade_terminal_init(const char *resources) {
    NSCAssert([NSThread isMainThread], @"terminal must run on main thread");
    if (app) return true;
    // Isolate resources. Deliberately do not load the user's Ghostty config.
    setenv("GHOSTTY_RESOURCES_DIR", resources, 1);
    if (ghostty_init(0, NULL) != GHOSTTY_SUCCESS) return false;
    config = ghostty_config_new();
    NSString *themePath = [[NSBundle mainBundle] pathForResource:@"terminal" ofType:@"conf"];
    ghostty_config_load_file(config, themePath ? themePath.fileSystemRepresentation : ADE_TERMINAL_THEME_PATH);
    ghostty_config_finalize(config);
    if (ghostty_config_diagnostics_count(config) != 0) {
        fprintf(stderr, "lux-ade terminal theme contains invalid configuration\n");
        ghostty_config_free(config);
        config = NULL;
        return false;
    }
    ghostty_runtime_config_s rt = {0};
    rt.wakeup_cb = wakeup; rt.action_cb = action;
    rt.read_clipboard_cb = read_clipboard; rt.confirm_read_clipboard_cb = confirm_clipboard;
    rt.write_clipboard_cb = write_clipboard; rt.close_surface_cb = close_surface;
    app = ghostty_app_new(&rt, config);
    return app != NULL;
}

@implementation ADETerminalView
- (BOOL)isFlipped { return YES; }
- (BOOL)acceptsFirstResponder { return YES; }
- (BOOL)becomeFirstResponder {
    if (self.surface) ghostty_surface_set_focus(self.surface, NSApp.isActive && self.window.isKeyWindow && !self.hidden);
    return YES;
}
- (BOOL)resignFirstResponder { if (self.surface) ghostty_surface_set_focus(self.surface, false); return YES; }
- (void)viewDidMoveToWindow {
    [super viewDidMoveToWindow];
    NSNotificationCenter *center = NSNotificationCenter.defaultCenter;
    [center removeObserver:self];
    if (self.window) {
        for (NSNotificationName name in @[NSWindowDidBecomeKeyNotification, NSWindowDidResignKeyNotification,
                NSWindowDidChangeOcclusionStateNotification, NSWindowDidMiniaturizeNotification, NSWindowDidDeminiaturizeNotification]) {
            [center addObserver:self selector:@selector(activityChanged:) name:name object:self.window];
        }
        for (NSNotificationName name in @[NSApplicationDidBecomeActiveNotification, NSApplicationDidResignActiveNotification]) {
            [center addObserver:self selector:@selector(activityChanged:) name:name object:NSApp];
        }
    }
    [self syncActivity];
}
- (void)activityChanged:(NSNotification *)notification { [self syncActivity]; }
- (void)syncActivity {
    if (!self.surface) return;
    BOOL visible = self.window && !self.hidden && !self.window.isMiniaturized
        && (self.window.occlusionState & NSWindowOcclusionStateVisible);
    ghostty_app_set_focus(app, NSApp.isActive);
    ghostty_surface_set_occlusion(self.surface, visible);
    ghostty_surface_set_focus(self.surface, visible && NSApp.isActive && self.window.isKeyWindow && self.window.firstResponder == self);
}
- (void)dealloc { [NSNotificationCenter.defaultCenter removeObserver:self]; }
- (void)viewDidChangeBackingProperties { [super viewDidChangeBackingProperties]; [self resizeSurface]; }
- (void)resizeSurface {
    if (!self.surface) return;
    CGFloat scale = self.window.backingScaleFactor ?: 1;
    ghostty_surface_set_content_scale(self.surface, scale, scale);
    ghostty_surface_set_size(self.surface, MAX(1, self.bounds.size.width * scale), MAX(1, self.bounds.size.height * scale));
}
- (ghostty_input_key_s)key:(NSEvent *)event action:(ghostty_input_action_e)action text:(NSString *)text {
    ghostty_input_key_s key = {0};
    key.action = action; key.mods = mods(event.modifierFlags); key.keycode = event.keyCode;
    key.consumed_mods = key.mods & GHOSTTY_MODS_SHIFT;
    NSString *plain = event.charactersIgnoringModifiers;
    if (plain.length) key.unshifted_codepoint = [plain characterAtIndex:0];
    key.text = text.length ? text.UTF8String : NULL;
    key.composing = [self hasMarkedText];
    return key;
}
- (void)keyDown:(NSEvent *)event {
    if (!self.surface) return;
    ghostty_input_key_s raw = [self key:event action:(event.isARepeat ? GHOSTTY_ACTION_REPEAT : GHOSTTY_ACTION_PRESS) text:nil];
    if (ghostty_surface_key_is_binding(self.surface, raw, NULL)) { ghostty_surface_key(self.surface, raw); return; }
    self.keyText = nil; self.interpreting = YES;
    [self interpretKeyEvents:@[event]];
    self.interpreting = NO;
    ghostty_input_key_s key = [self key:event action:raw.action text:self.keyText];
    ghostty_surface_key(self.surface, key);
    self.keyText = nil;
}
- (void)keyUp:(NSEvent *)event {
    if (self.surface) ghostty_surface_key(self.surface, [self key:event action:GHOSTTY_ACTION_RELEASE text:nil]);
}
- (BOOL)performKeyEquivalent:(NSEvent *)event {
    if (self.window.firstResponder != self || !self.surface) return NO;
    ghostty_input_key_s key = [self key:event action:GHOSTTY_ACTION_PRESS text:nil];
    if (ghostty_surface_key_is_binding(self.surface, key, NULL)) { ghostty_surface_key(self.surface, key); return YES; }
    return NO;
}
- (void)doCommandBySelector:(SEL)selector { /* keyDown forwards the physical key. */ }
- (void)insertText:(id)text replacementRange:(NSRange)range {
    NSString *plain = [text isKindOfClass:[NSAttributedString class]] ? [text string] : text;
    [self unmarkText];
    if (self.interpreting) self.keyText = [(self.keyText ?: @"") stringByAppendingString:plain];
    else if (self.surface) ghostty_surface_text(self.surface, plain.UTF8String, [plain lengthOfBytesUsingEncoding:NSUTF8StringEncoding]);
}
- (void)setMarkedText:(id)text selectedRange:(NSRange)selection replacementRange:(NSRange)replacement {
    self.marked = [text isKindOfClass:[NSAttributedString class]] ? [text mutableCopy] : [[NSMutableAttributedString alloc] initWithString:text];
    if (self.surface) ghostty_surface_preedit(self.surface, self.marked.string.UTF8String,
        [self.marked.string lengthOfBytesUsingEncoding:NSUTF8StringEncoding]);
}
- (void)unmarkText { self.marked = nil; if (self.surface) ghostty_surface_preedit(self.surface, NULL, 0); }
- (BOOL)hasMarkedText { return self.marked.length > 0; }
- (NSRange)markedRange { return [self hasMarkedText] ? NSMakeRange(0, self.marked.length) : NSMakeRange(NSNotFound, 0); }
- (NSRange)selectedRange { return NSMakeRange(NSNotFound, 0); }
- (NSArray<NSAttributedStringKey> *)validAttributesForMarkedText { return @[]; }
- (NSAttributedString *)attributedSubstringForProposedRange:(NSRange)range actualRange:(NSRangePointer)actual { return nil; }
- (NSUInteger)characterIndexForPoint:(NSPoint)point { return NSNotFound; }
- (NSRect)firstRectForCharacterRange:(NSRange)range actualRange:(NSRangePointer)actual {
    double x=0,y=0,w=1,h=16;
    if (self.surface) ghostty_surface_ime_point(self.surface,&x,&y,&w,&h);
    return [self.window convertRectToScreen:[self convertRect:NSMakeRect(x,y,w,h) toView:nil]];
}
- (void)mouseMoved:(NSEvent *)event {
    if (!self.surface) return;
    NSPoint p = [self convertPoint:event.locationInWindow fromView:nil];
    ghostty_surface_mouse_pos(self.surface,p.x,p.y,mods(event.modifierFlags));
}
- (void)mouseDown:(NSEvent *)event { [self.window makeFirstResponder:self]; [self mouseMoved:event];
    if (self.surface) ghostty_surface_mouse_button(self.surface,GHOSTTY_MOUSE_PRESS,GHOSTTY_MOUSE_LEFT,mods(event.modifierFlags)); }
- (void)mouseUp:(NSEvent *)event { [self mouseMoved:event];
    if (self.surface) ghostty_surface_mouse_button(self.surface,GHOSTTY_MOUSE_RELEASE,GHOSTTY_MOUSE_LEFT,mods(event.modifierFlags)); }
- (void)mouseDragged:(NSEvent *)event { [self mouseMoved:event]; }
- (void)rightMouseDown:(NSEvent *)event { [self mouseMoved:event];
    if (self.surface) ghostty_surface_mouse_button(self.surface,GHOSTTY_MOUSE_PRESS,GHOSTTY_MOUSE_RIGHT,mods(event.modifierFlags)); }
- (void)rightMouseUp:(NSEvent *)event { [self mouseMoved:event];
    if (self.surface) ghostty_surface_mouse_button(self.surface,GHOSTTY_MOUSE_RELEASE,GHOSTTY_MOUSE_RIGHT,mods(event.modifierFlags)); }
- (void)scrollWheel:(NSEvent *)event {
    if (self.surface) ghostty_surface_mouse_scroll(self.surface,event.scrollingDeltaX,event.scrollingDeltaY,event.hasPreciseScrollingDeltas ? 1 : 0);
}
@end

void *ade_terminal_create(void *parent, const char *command, const char *cwd) {
    NSCAssert([NSThread isMainThread], @"terminal must run on main thread");
    if (!app || !parent) return NULL;
    NSView *parentView = (__bridge NSView *)parent;
    ADETerminalView *view = [[ADETerminalView alloc] initWithFrame:NSMakeRect(0,0,800,500)];
    view.wantsLayer = YES;
    [parentView addSubview:view];
    ghostty_surface_config_s cfg = ghostty_surface_config_new();
    cfg.platform_tag = GHOSTTY_PLATFORM_MACOS;
    cfg.platform.macos.nsview = (__bridge void *)view;
    cfg.userdata = (__bridge void *)view;
    cfg.scale_factor = parentView.window.backingScaleFactor ?: 1;
    cfg.font_size = 13; cfg.command = command; cfg.working_directory = cwd;
    cfg.wait_after_command = false;
    view.surface = ghostty_surface_new(app, &cfg);
    if (!view.surface) { [view removeFromSuperview]; return NULL; }
    [view resizeSurface];
    [view syncActivity];
    return (__bridge_retained void *)view;
}
void ade_terminal_bounds(void *handle, double x,double y,double w,double h,double scale) {
    ADETerminalView *view = (__bridge ADETerminalView *)handle;
    if (!view) return;
    NSView *parent = view.superview;
    CGFloat nativeY = parent.isFlipped ? y : parent.bounds.size.height - y - h;
    NSRect rect = NSMakeRect(x,nativeY,MAX(1,w),MAX(1,h));
    if (!NSEqualRects(view.frame,rect)) { view.frame = rect; [view resizeSurface]; }
}
// Query the specific child, not merely the responder's class: a Dock window
// can contain several terminal and WKWebView instances at once.
bool ade_native_view_is_focused(const void *handle) {
    NSView *view = (__bridge NSView *)handle;
    if (!view || view.isHiddenOrHasHiddenAncestor || !NSApp.isActive || !view.window.isKeyWindow) return false;
    NSResponder *responder = view.window.firstResponder;
    if (responder == view) return true;
    return [responder isKindOfClass:[NSView class]] && [(NSView *)responder isDescendantOf:view];
}
bool ade_terminal_is_focused(void *handle) {
    return ade_native_view_is_focused(handle);
}
void ade_terminal_focus(void *handle) {
    ADETerminalView *view = (__bridge ADETerminalView *)handle;
    [view.window makeFirstResponder:view];
}
void ade_terminal_visible(void *handle, bool visible) {
    ADETerminalView *view = (__bridge ADETerminalView *)handle;
    if (!visible && view.window.firstResponder == view) {
        [view.window makeFirstResponder:view.superview];
    }
    view.hidden = !visible;
    [view syncActivity];
}
void ade_terminal_tick(void) { if (app) ghostty_app_tick(app); }
bool ade_terminal_exited(void *handle) {
    ADETerminalView *view = (__bridge ADETerminalView *)handle;
    return !view.surface || ghostty_surface_process_exited(view.surface);
}
bool ade_terminal_restore(void *handle, const uint8_t *bytes, size_t len) {
    NSCAssert([NSThread isMainThread], @"terminal must run on main thread");
    ADETerminalView *view = (__bridge ADETerminalView *)handle;
    return view.surface && ghostty_surface_restore_snapshot(view.surface, bytes, len);
}
bool ade_terminal_feed(void *handle, const uint8_t *bytes, size_t len) {
    NSCAssert([NSThread isMainThread], @"terminal must run on main thread");
    ADETerminalView *view = (__bridge ADETerminalView *)handle;
    return view.surface && ghostty_surface_feed_output(view.surface, bytes, len);
}
bool ade_terminal_resize_grid(void *handle, uint16_t cols, uint16_t rows) {
    NSCAssert([NSThread isMainThread], @"terminal must run on main thread");
    ADETerminalView *view = (__bridge ADETerminalView *)handle;
    return view.surface && ghostty_surface_resize_terminal(view.surface, cols, rows);
}
void ade_terminal_destroy(void *handle) {
    NSCAssert([NSThread isMainThread], @"terminal must run on main thread");
    ADETerminalView *view = (__bridge_transfer ADETerminalView *)handle;
    [NSNotificationCenter.defaultCenter removeObserver:view];
    if (view.window.firstResponder == view) [view.window makeFirstResponder:nil];
    if (view.surface) {
        ghostty_surface_set_focus(view.surface, false);
        ghostty_surface_t surface = view.surface;
        view.surface = NULL;
        ghostty_surface_free(surface);
    }
    [view removeFromSuperview];
}

// A separate GPUI-rendered panel is composed by AppKit above both native children.
// This object owns only the parent/child relationship, never either GPUI window.
@interface ADEChildWindowLink : NSObject
@property(nonatomic, weak) NSWindow *parent;
@property(nonatomic, weak) NSWindow *child;
@property(nonatomic, assign) NSWindowLevel originalLevel;
@property(nonatomic, assign) BOOL originalHidesOnDeactivate;
- (void)center;
- (void)detach;
@end
@implementation ADEChildWindowLink
- (void)center {
    NSWindow *parent = self.parent, *child = self.child;
    if (!parent || !child || !parent.contentView) return;
    NSRect content = [parent convertRectToScreen:[parent.contentView convertRect:parent.contentView.bounds toView:nil]];
    NSRect frame = child.frame;
    frame.origin = NSMakePoint(NSMidX(content) - frame.size.width / 2., NSMidY(content) - frame.size.height / 2.);
    [child setFrameOrigin:frame.origin];
}
- (void)parentResized:(NSNotification *)notification { [self center]; }
- (void)parentClosing:(NSNotification *)notification {
    NSWindow *child = self.child;
    [self detach];
    [child orderOut:nil];
    // GPUI overrides -close to notify its window registry. Defer to avoid
    // re-entering GPUI while the parent is delivering its close callback.
    if (child) dispatch_async(dispatch_get_main_queue(), ^{ [child close]; });
}
- (void)childClosing:(NSNotification *)notification { [self detach]; }
- (void)detach {
    [NSNotificationCenter.defaultCenter removeObserver:self];
    NSWindow *parent = self.parent, *child = self.child;
    if (child.parentWindow == parent && parent) [parent removeChildWindow:child];
    if (child) { child.level = self.originalLevel; child.hidesOnDeactivate = self.originalHidesOnDeactivate; }
    self.parent = nil; self.child = nil;
}
- (void)dealloc { [NSNotificationCenter.defaultCenter removeObserver:self]; }
@end

void *ade_child_window_attach(void *parentView, void *childView) {
    NSCAssert([NSThread isMainThread], @"child windows must run on main thread");
    NSWindow *parent = ((__bridge NSView *)parentView).window;
    NSWindow *child = ((__bridge NSView *)childView).window;
    if (!parent || !child || parent == child || child.parentWindow) return NULL;
    ADEChildWindowLink *link = [ADEChildWindowLink new];
    link.parent = parent; link.child = child;
    link.originalLevel = child.level; link.originalHidesOnDeactivate = child.hidesOnDeactivate;
    // Stay associated with this workspace; never float over other applications.
    child.level = parent.level; child.hidesOnDeactivate = YES;
    [parent addChildWindow:child ordered:NSWindowAbove];
    [link center];
    NSNotificationCenter *center = NSNotificationCenter.defaultCenter;
    [center addObserver:link selector:@selector(parentResized:) name:NSWindowDidResizeNotification object:parent];
    [center addObserver:link selector:@selector(parentClosing:) name:NSWindowWillCloseNotification object:parent];
    [center addObserver:link selector:@selector(childClosing:) name:NSWindowWillCloseNotification object:child];
    [child orderFront:nil];
    return (__bridge_retained void *)link;
}
void ade_child_window_detach(void *handle) {
    NSCAssert([NSThread isMainThread], @"child windows must run on main thread");
    ADEChildWindowLink *link = (__bridge_transfer ADEChildWindowLink *)handle;
    [link detach];
}

// App-local routing precedes native child views. Only registered Cmd chords are
// consumed; terminal control keys, IME input and ordinary browser editing pass on.
typedef void (*ADECommandCallback)(void *, unsigned int);
@interface ADECommandBridge : NSObject
@property(nonatomic, weak) NSView *parent;
@property(nonatomic) void *context;
@property(nonatomic) ADECommandCallback callback;
@property(nonatomic, strong) id monitor;
- (void)invoke:(NSMenuItem *)item;
@end
static NSArray *adeBindings;
static NSHashTable<ADECommandBridge *> *adeCommandBridges;
@implementation ADECommandBridge
- (BOOL)validateMenuItem:(NSMenuItem *)item {
    for (ADECommandBridge *bridge in adeCommandBridges)
        if (bridge.parent.window == NSApp.keyWindow) return YES;
    return NO;
}
- (void)invoke:(NSMenuItem *)item {
    for (ADECommandBridge *bridge in adeCommandBridges) {
        if (bridge.parent.window == NSApp.keyWindow) {
            bridge.callback(bridge.context, (unsigned int)item.tag); return;
        }
    }
}
@end
void *ade_commands_watch(void *parent, ADECommandCallback callback, void *context) {
    if (!adeCommandBridges) adeCommandBridges = [NSHashTable weakObjectsHashTable];
    ADECommandBridge *bridge = [ADECommandBridge new];
    bridge.parent = (__bridge NSView *)parent; bridge.callback = callback; bridge.context = context;
    [adeCommandBridges addObject:bridge];
    __weak ADECommandBridge *weak = bridge;
    bridge.monitor = [NSEvent addLocalMonitorForEventsMatchingMask:NSEventMaskKeyDown handler:^NSEvent *(NSEvent *event) {
        ADECommandBridge *owner = weak;
        if (!owner || event.window != owner.parent.window) return event;
        NSUInteger mask = event.modifierFlags & (NSEventModifierFlagCommand|NSEventModifierFlagShift|NSEventModifierFlagControl|NSEventModifierFlagOption);
        if (!(mask & NSEventModifierFlagCommand)) return event;
        NSString *key = [[event charactersByApplyingModifiers:0] lowercaseString];
        for (NSDictionary *entry in adeBindings) {
            if ([entry[@"key"] length] && [entry[@"mask"] unsignedIntegerValue] == mask && [entry[@"key"] isEqualToString:key]) {
                owner.callback(owner.context, [entry[@"index"] unsignedIntValue]); return nil;
            }
        }
        return event;
    }];
    return (__bridge_retained void *)bridge;
}
void ade_commands_unwatch(void *handle) {
    ADECommandBridge *bridge = (__bridge_transfer ADECommandBridge *)handle;
    [NSEvent removeMonitor:bridge.monitor]; bridge.monitor = nil;
    [adeCommandBridges removeObject:bridge];
}
void ade_commands_configure(const char *json) {
    NSData *data = [[NSString stringWithUTF8String:json] dataUsingEncoding:NSUTF8StringEncoding];
    NSArray *entries = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
    if (![entries isKindOfClass:[NSArray class]]) return;
    adeBindings = entries;
    static ADECommandBridge *menuTarget;
    if (!menuTarget) menuTarget = [ADECommandBridge new];
    // Keep GPUI's registered Edit items and their action-table tags. Replacing
    // them with raw targetless items breaks native validation and GPUI actions.
    NSMenu *root = NSApp.mainMenu;
    if (!root) return;
    NSMenu *app = [root itemAtIndex:0].submenu;
    if (![app itemWithTitle:@"Quit lux-ade"])
        [app addItemWithTitle:@"Quit lux-ade" action:@selector(terminate:) keyEquivalent:@"q"].target = NSApp;
    for (NSString *group in @[@"Workspace",@"View",@"Tabs"]) {
        NSMenuItem *previous = [root itemWithTitle:group];
        if (previous) [root removeItem:previous];
        NSMenu *menu=[[NSMenu alloc] initWithTitle:group];
        [root addItemWithTitle:group action:nil keyEquivalent:@""].submenu=menu;
        for (NSDictionary *entry in entries) if ([entry[@"group"] isEqualToString:group]) {
            NSMenuItem *item=[menu addItemWithTitle:entry[@"title"] action:@selector(invoke:) keyEquivalent:entry[@"key"]];
            item.keyEquivalentModifierMask=[entry[@"mask"] unsignedIntegerValue];item.tag=[entry[@"index"] integerValue];item.target=menuTarget;
        }
    }
    NSApp.mainMenu=root;
}
unsigned int ade_focus_kind(void *parent) {
    NSView *view=(__bridge NSView *)parent; NSResponder *responder=view.window.firstResponder;
    if ([responder isKindOfClass:[ADETerminalView class]]) return 3;
    for (NSView *child=[responder isKindOfClass:[NSView class]]?(NSView *)responder:nil; child; child=child.superview) {
        if ([NSStringFromClass(child.class) containsString:@"WK"]) return 4;
    }
    return 0;
}
void ade_focus_parent(void *parent) {
    NSView *view=(__bridge NSView *)parent; [view.window makeFirstResponder:view];
}
