#import <Foundation/Foundation.h>
#import <UserNotifications/UserNotifications.h>

typedef void (*PheemeClick)(const char *);
typedef void (*PheemeCompletion)(void *, int32_t);
static PheemeClick clickHandler;

@interface PheemeNotificationDelegate : NSObject <UNUserNotificationCenterDelegate>
@end
@implementation PheemeNotificationDelegate
- (void)userNotificationCenter:(UNUserNotificationCenter *)center
    didReceiveNotificationResponse:(UNNotificationResponse *)response
    withCompletionHandler:(void (^)(void))completionHandler {
    if ([response.actionIdentifier isEqualToString:UNNotificationDefaultActionIdentifier]) {
        NSString *target = response.notification.request.content.userInfo[@"target"];
        if ([target isKindOfClass:[NSString class]] && clickHandler) { clickHandler(target.UTF8String); }
    }
    completionHandler();
}
// Let macOS apply Focus, notification preferences and presentation policy. Do not request
// critical or time-sensitive alerts. Foreground mail can use the same normal banner policy.
- (void)userNotificationCenter:(UNUserNotificationCenter *)center
    willPresentNotification:(UNNotification *)notification
    withCompletionHandler:(void (^)(UNNotificationPresentationOptions))completionHandler {
    completionHandler(UNNotificationPresentationOptionBanner | UNNotificationPresentationOptionList | UNNotificationPresentationOptionSound);
}
@end
static PheemeNotificationDelegate *notificationDelegate;

void pheeme_notifications_init(PheemeClick click) {
    clickHandler = click;
    // UNUserNotificationCenter requires an app bundle; `cargo test` never calls this bridge.
    if (![NSBundle mainBundle].bundleIdentifier) { return; }
    notificationDelegate = [PheemeNotificationDelegate new];
    [UNUserNotificationCenter currentNotificationCenter].delegate = notificationDelegate;
}

void pheeme_notifications_permission(bool request, void *context, PheemeCompletion callback) {
    if (![NSBundle mainBundle].bundleIdentifier) { callback(context, -1); return; }
    UNUserNotificationCenter *center = [UNUserNotificationCenter currentNotificationCenter];
    [center getNotificationSettingsWithCompletionHandler:^(UNNotificationSettings *settings) {
        if (request && settings.authorizationStatus == UNAuthorizationStatusNotDetermined) {
            [center requestAuthorizationWithOptions:(UNAuthorizationOptionAlert | UNAuthorizationOptionSound)
                completionHandler:^(BOOL granted, NSError *error) { callback(context, error ? -1 : (granted ? 2 : 1)); }];
        } else { callback(context, (int32_t)settings.authorizationStatus); }
    }];
}

void pheeme_notifications_show(const char *title, const char *body, const char *target,
                              void *context, PheemeCompletion callback) {
    if (![NSBundle mainBundle].bundleIdentifier) { callback(context, -1); return; }
    UNMutableNotificationContent *content = [UNMutableNotificationContent new];
    content.title = [NSString stringWithUTF8String:title];
    content.body = [NSString stringWithUTF8String:body];
    content.userInfo = @{@"target": [NSString stringWithUTF8String:target]};
    content.sound = [UNNotificationSound defaultSound];
    UNNotificationRequest *request = [UNNotificationRequest requestWithIdentifier:[NSUUID UUID].UUIDString content:content trigger:nil];
    [[UNUserNotificationCenter currentNotificationCenter] addNotificationRequest:request
        withCompletionHandler:^(NSError *error) { callback(context, error ? -1 : 0); }];
}
