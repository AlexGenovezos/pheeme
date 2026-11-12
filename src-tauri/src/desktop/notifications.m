#import <Foundation/Foundation.h>
#import <UserNotifications/UserNotifications.h>

typedef void (*PheemeClick)(const char *);
typedef void (*PheemeCompletion)(void *, int32_t);
static PheemeClick clickHandler;
static PheemeClick joinHandler;
// A reminder for a video call offers Join, which opens the call without bringing Pheeme forward.
static NSString *const PheemeCallCategory = @"pheeme.call";
static NSString *const PheemeJoinAction = @"pheeme.join";

@interface PheemeNotificationDelegate : NSObject <UNUserNotificationCenterDelegate>
@end
@implementation PheemeNotificationDelegate
- (void)userNotificationCenter:(UNUserNotificationCenter *)center
    didReceiveNotificationResponse:(UNNotificationResponse *)response
    withCompletionHandler:(void (^)(void))completionHandler {
    NSDictionary *info = response.notification.request.content.userInfo;
    if ([response.actionIdentifier isEqualToString:UNNotificationDefaultActionIdentifier]) {
        NSString *target = info[@"target"];
        if ([target isKindOfClass:[NSString class]] && clickHandler) { clickHandler(target.UTF8String); }
    } else if ([response.actionIdentifier isEqualToString:PheemeJoinAction]) {
        NSString *join = info[@"join"];
        if ([join isKindOfClass:[NSString class]] && joinHandler) { joinHandler(join.UTF8String); }
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

void pheeme_notifications_init(PheemeClick click, PheemeClick join) {
    clickHandler = click;
    joinHandler = join;
    // UNUserNotificationCenter requires an app bundle; `cargo test` never calls this bridge.
    if (![NSBundle mainBundle].bundleIdentifier) { return; }
    notificationDelegate = [PheemeNotificationDelegate new];
    UNUserNotificationCenter *center = [UNUserNotificationCenter currentNotificationCenter];
    center.delegate = notificationDelegate;
    UNNotificationAction *joinAction = [UNNotificationAction actionWithIdentifier:PheemeJoinAction
                                                                            title:@"Join"
                                                                          options:UNNotificationActionOptionNone];
    UNNotificationCategory *call = [UNNotificationCategory categoryWithIdentifier:PheemeCallCategory
                                                                          actions:@[joinAction]
                                                                intentIdentifiers:@[]
                                                                          options:UNNotificationCategoryOptionNone];
    [center setNotificationCategories:[NSSet setWithObject:call]];
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
                              const char *join, void *context, PheemeCompletion callback) {
    if (![NSBundle mainBundle].bundleIdentifier) { callback(context, -1); return; }
    UNMutableNotificationContent *content = [UNMutableNotificationContent new];
    content.title = [NSString stringWithUTF8String:title];
    content.body = [NSString stringWithUTF8String:body];
    if (join) {
        content.userInfo = @{@"target": [NSString stringWithUTF8String:target],
                             @"join": [NSString stringWithUTF8String:join]};
        content.categoryIdentifier = PheemeCallCategory;
    } else {
        content.userInfo = @{@"target": [NSString stringWithUTF8String:target]};
    }
    content.sound = [UNNotificationSound defaultSound];
    UNNotificationRequest *request = [UNNotificationRequest requestWithIdentifier:[NSUUID UUID].UUIDString content:content trigger:nil];
    [[UNUserNotificationCenter currentNotificationCenter] addNotificationRequest:request
        withCompletionHandler:^(NSError *error) { callback(context, error ? -1 : 0); }];
}
