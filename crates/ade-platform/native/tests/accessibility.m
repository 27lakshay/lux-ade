#import <AppKit/AppKit.h>
#import <objc/runtime.h>
#include <assert.h>

extern void ade_accessibility_register_child(void *, const void *);

// Model AccessKit's containing view, distinct from GPUI's raw rendering view.
@interface AccessKitSubclassOfADEAXFixture : NSView
@end
@implementation AccessKitSubclassOfADEAXFixture
- (NSArray *)accessibilityChildren { return @[@"virtual-tree-sentinel"]; }
- (id)accessibilityFocusedUIElement { return self; }
- (id)accessibilityHitTest:(NSPoint)point { return self; }
@end

int main(void) {
    @autoreleasepool {
        [NSApplication sharedApplication];
        NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, 400, 300)
            styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO];
        window.releasedWhenClosed = NO;
        AccessKitSubclassOfADEAXFixture *host = [[AccessKitSubclassOfADEAXFixture alloc]
            initWithFrame:NSMakeRect(0, 0, 400, 300)];
        window.contentView = host;
        NSView *render = [[NSView alloc] initWithFrame:host.bounds];
        [host addSubview:render];
        NSView *native = [[NSView alloc] initWithFrame:NSMakeRect(10, 10, 100, 100)];
        native.accessibilityElement = YES;
        native.accessibilityRole = NSAccessibilityGroupRole;
        [render addSubview:native];
        ade_accessibility_register_child((__bridge void *)render, (__bridge void *)native);
        ade_accessibility_register_child((__bridge void *)render, (__bridge void *)native);
        assert(host.accessibilityChildren.count == 2);
        assert([host.accessibilityChildren.firstObject isEqual:@"virtual-tree-sentinel"]);
        assert(host.accessibilityChildren.lastObject == native);
        assert([NSStringFromClass(object_getClass(host)) hasPrefix:@"ADENativeAX_"]);
        assert([host accessibilityFocusedUIElement] == host);
        assert([host accessibilityHitTest:NSMakePoint(-10000, -10000)] == host);
        native.hidden = YES;
        assert(host.accessibilityChildren.count == 1);
        native.hidden = NO;
        render.hidden = YES;
        assert(host.accessibilityChildren.count == 1);
        render.hidden = NO;
        assert(host.accessibilityChildren.count == 2);
        [native removeFromSuperview];
        assert(host.accessibilityChildren.count == 1);
        native = nil;
        // AccessKit restores its original class when dropping its adapter.
        object_setClass(host, AccessKitSubclassOfADEAXFixture.class);
        assert(host.accessibilityChildren.count == 1);
        [window close];
    }
    return 0;
}
