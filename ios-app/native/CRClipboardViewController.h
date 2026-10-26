// SPDX-License-Identifier: GPL-3.0-or-later
#import <UIKit/UIKit.h>
#import "TemporaryHost.h"

@interface CRClipboardViewController : UIViewController
- (instancetype)initWithHost:(TemporaryHost *)host;
@end
