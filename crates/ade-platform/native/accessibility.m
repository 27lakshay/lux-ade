#import <AppKit/AppKit.h>
#import <objc/runtime.h>
#import <objc/message.h>

// AccessKit replaces the host's accessibility children with its virtual tree.
// Append registered native children without replacing that tree. Both the host
// and native views stay owned by GPUI/Wry; this table holds only weak references.
static char nativeChildrenKey;

static NSArray<NSView *> *visibleChildren(NSView *host) {
    NSHashTable *views = objc_getAssociatedObject(host, &nativeChildrenKey);
    NSMutableArray *visible = [NSMutableArray array];
    for (NSView *view in views.allObjects) {
        if (view.superview && view.window == host.window &&
            !view.isHiddenOrHasHiddenAncestor) [visible addObject:view];
    }
    return visible;
}

static id original(id host, SEL selector) {
    struct objc_super parent = {host, class_getSuperclass(object_getClass(host))};
    return ((id (*)(struct objc_super *, SEL))objc_msgSendSuper)(&parent, selector);
}

static id children(NSView *host, SEL selector) {
    NSMutableArray *result = [original(host, selector) mutableCopy] ?: [NSMutableArray array];
    for (NSView *view in visibleChildren(host)) {
        id child = NSAccessibilityUnignoredDescendant(view);
        if (child && ![result containsObject:child]) [result addObject:child];
    }
    return result;
}

static id focus(NSView *host, SEL selector) {
    NSResponder *responder = host.window.firstResponder;
    if ([responder isKindOfClass:NSView.class]) {
        for (NSView *view in visibleChildren(host)) {
            if (responder == view || [(NSView *)responder isDescendantOf:view]) {
                id focused = [view accessibilityFocusedUIElement];
                if (focused) return focused;
            }
        }
    }
    return original(host, selector);
}

static id hitTest(NSView *host, SEL selector, NSPoint point) {
    for (NSView *view in visibleChildren(host)) {
        NSRect screen = [view.window convertRectToScreen:[view convertRect:view.bounds toView:nil]];
        if (NSPointInRect(point, screen)) {
            id hit = [view accessibilityHitTest:point];
            if (hit) return hit;
        }
    }
    struct objc_super parent = {host, class_getSuperclass(object_getClass(host))};
    return ((id (*)(struct objc_super *, SEL, NSPoint))objc_msgSendSuper)(&parent, selector, point);
}

void ade_accessibility_register_child(void *parent, const void *child) {
    if (!parent || !child || !NSThread.isMainThread) return;
    // GPUI's raw handle points to its rendering subview. AccessKit's
    // for_window adapter subclasses the containing window's content view.
    NSView *host = ((__bridge NSView *)parent).window.contentView;
    if (!host) return;
    NSView *view = (__bridge NSView *)child;
    Class base = object_getClass(host);
    NSString *name = NSStringFromClass(base);
    if (![name hasPrefix:@"ADENativeAX_"]) {
        // May be called during initial rendering before GPUI installs AccessKit.
        // The next render retries, without subclassing an unrelated native view.
        if (![name hasPrefix:@"AccessKitSubclassOf"]) return;
        NSString *subclassName = [@"ADENativeAX_" stringByAppendingString:name];
        Class subclass = NSClassFromString(subclassName);
        if (!subclass) {
            subclass = objc_allocateClassPair(base, subclassName.UTF8String, 0);
            if (!subclass) return;
            class_addMethod(subclass, @selector(accessibilityChildren), (IMP)children,
                method_getTypeEncoding(class_getInstanceMethod(base, @selector(accessibilityChildren))));
            class_addMethod(subclass, @selector(accessibilityFocusedUIElement), (IMP)focus,
                method_getTypeEncoding(class_getInstanceMethod(base, @selector(accessibilityFocusedUIElement))));
            class_addMethod(subclass, @selector(accessibilityHitTest:), (IMP)hitTest,
                method_getTypeEncoding(class_getInstanceMethod(base, @selector(accessibilityHitTest:))));
            objc_registerClassPair(subclass);
        }
        // No instance storage is added. AccessKit still owns/restores its class
        // and adapter; these overrides only forward and append native results.
        object_setClass(host, subclass);
    }
    NSHashTable *views = objc_getAssociatedObject(host, &nativeChildrenKey);
    if (!views) {
        views = [NSHashTable weakObjectsHashTable];
        objc_setAssociatedObject(host, &nativeChildrenKey, views, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    }
    if (![views containsObject:view]) {
        [views addObject:view];
        NSAccessibilityPostNotification(host, NSAccessibilityLayoutChangedNotification);
    }
}
