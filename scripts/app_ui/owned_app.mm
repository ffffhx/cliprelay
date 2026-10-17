// Disposable CI only. Launch the unchanged app through Launch Services; the
// helper owns an explicit lease and can inspect/press only its exact app menu.
#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#include <atomic>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <libproc.h>
#include <limits.h>
#include <sys/proc_info.h>
#include <sys/stat.h>
#include <thread>
#include <unistd.h>
static NSRunningApplication *application;
static NSString *expected_path;
static struct proc_bsdinfo original;
static pid_t owner;
static bool closing=false,forced=false;
static std::chrono::steady_clock::time_point close_at,deadline;
static void emit(NSDictionary *value){
  NSData *json=[NSJSONSerialization dataWithJSONObject:value options:0 error:nullptr];
  if(!json||json.length>32768)exit(3);fwrite(json.bytes,1,json.length,stdout);fputc('\n',stdout);fflush(stdout);
}
static bool owned(){
  if(!application||application.terminated)return false;
  struct proc_bsdinfo info={};char executable[PROC_PIDPATHINFO_MAXSIZE]={};pid_t pid=application.processIdentifier;
  return proc_pidinfo(pid,PROC_PIDTBSDINFO,0,&info,sizeof info)==sizeof info&&info.pbi_pid==(unsigned)pid&&
    info.pbi_uid==getuid()&&info.pbi_ruid==getuid()&&info.pbi_start_tvsec==original.pbi_start_tvsec&&
    info.pbi_start_tvusec==original.pbi_start_tvusec&&proc_pidpath(pid,executable,sizeof executable)>0&&
    [@(executable) isEqualToString:expected_path];
}
static NSString *text(AXUIElementRef node,CFStringRef key){
  CFTypeRef value=nullptr;NSString *result=@"";
  if(AXUIElementCopyAttributeValue(node,key,&value)==kAXErrorSuccess&&value){
    if(CFGetTypeID(value)==CFStringGetTypeID())result=[(__bridge NSString *)value copy];CFRelease(value);
  }
  return result.length<=200?result:@"";
}
static void traverse(AXUIElementRef node,unsigned depth,unsigned &budget,NSMutableArray *rows,NSMutableArray *matches,NSString *command,
                     std::chrono::steady_clock::time_point end){
  if(depth>12||!budget||std::chrono::steady_clock::now()>=end)return;--budget;AXUIElementSetMessagingTimeout(node,.05);
  NSString *role=text(node,kAXRoleAttribute),*title=text(node,kAXTitleAttribute),*description=text(node,kAXDescriptionAttribute);
  if(rows.count<100&&(title.length||description.length))[rows addObject:@{@"role":role,@"title":title,@"description":description,@"depth":@(depth)}];
  BOOL match=NO;
  if([command isEqualToString:@"menu"])match=[role isEqualToString:@"AXMenuBarItem"]&&([title isEqualToString:@"ClipRelay"]||[description isEqualToString:@"ClipRelay"]);
  NSString *wanted=[@{@"host":@"允许其他设备连接这台 Mac…",@"paired":@"配对电脑与安全收发…",@"permissions":@"本机远程访问权限…",@"exit":@"退出 ClipRelay"} objectForKey:command];
  if(wanted)match=[role isEqualToString:@"AXMenuItem"]&&[title isEqualToString:wanted];
  if(match)[matches addObject:(__bridge id)node];
  // Follow children once. Rewalking menu-bar relations repeats the same tree
  // and can exhaust the bound before reaching the application's status item.
  for(NSString *key in @[@"AXChildren"]){
    CFTypeRef value=nullptr;
    if(AXUIElementCopyAttributeValue(node,(__bridge CFStringRef)key,&value)!=kAXErrorSuccess||!value)continue;
    if(CFGetTypeID(value)==AXUIElementGetTypeID())traverse((AXUIElementRef)value,depth+1,budget,rows,matches,command,end);
    else if(CFGetTypeID(value)==CFArrayGetTypeID())for(id child in (__bridge NSArray *)value){
      if(CFGetTypeID((__bridge CFTypeRef)child)==AXUIElementGetTypeID())traverse((__bridge AXUIElementRef)child,depth+1,budget,rows,matches,command,end);
    }
    CFRelease(value);
  }
}
static bool inspect(NSString *command){
  if(!owned()){emit(@{@"event":@"error",@"code":@"APP_IDENTITY_CHANGED"});return false;}
  const BOOL trusted=AXIsProcessTrusted();NSMutableArray *rows=[NSMutableArray array],*matches=[NSMutableArray array];
  unsigned budget=250;AXError action=kAXErrorFailure;BOOL menu_root=NO;
  if(trusted){
    AXUIElementRef app=AXUIElementCreateApplication(application.processIdentifier);
    AXUIElementSetMessagingTimeout(app,.1);CFTypeRef extra=nullptr;
    if(AXUIElementCopyAttributeValue(app,CFSTR("AXExtrasMenuBar"),&extra)==kAXErrorSuccess&&extra){
      if(CFGetTypeID(extra)==AXUIElementGetTypeID()){
        menu_root=YES;traverse((AXUIElementRef)extra,0,budget,rows,matches,command,std::chrono::steady_clock::now()+std::chrono::seconds(3));
      }
      CFRelease(extra);
    }
    CFRelease(app);
  }
  // AX relations can repeat the same object; collapse identity-equal nodes.
  NSMutableArray *unique=[NSMutableArray array];for(id node in matches)if(![unique containsObject:node])[unique addObject:node];
  BOOL attempted=NO;
  if(![command isEqualToString:@"inspect"]&&unique.count==1&&budget&&owned()){
    AXUIElementSetMessagingTimeout((__bridge AXUIElementRef)unique[0],.5);
    attempted=YES;action=AXUIElementPerformAction((__bridge AXUIElementRef)unique[0],kAXPressAction);
  }
  emit(@{@"event":@"ui",@"command":command,@"owned":@(owned()),@"trusted":@(trusted),@"matches":@(unique.count),
    @"menuRootAvailable":@(menu_root),@"remainingBudget":@(budget),@"attempted":@(attempted),
    @"pressed":@(attempted&&action==kAXErrorSuccess),
    @"completionUnknown":@(attempted&&action==kAXErrorCannotComplete),@"actionStatus":@(action),@"nodes":rows});
  return attempted&&(action==kAXErrorSuccess||action==kAXErrorCannotComplete);
}
static void close_owned(){
  if(closing)return;closing=true;close_at=std::chrono::steady_clock::now();
  if(owned()&&!inspect(@"exit"))[application terminate];
}
int main(int argc,char **argv){
  @autoreleasepool {
    const char *temporary=getenv("RUNNER_TEMP");char root[PATH_MAX]={},app_path[PATH_MAX]={};struct stat channel={};
    if(argc!=3||!getenv("GITHUB_ACTIONS")||strcmp(getenv("GITHUB_ACTIONS"),"true")||!getenv("GITHUB_REPOSITORY")||
       strcmp(getenv("GITHUB_REPOSITORY"),"ffffhx/cliprelay")||!temporary||!realpath(temporary,root)||!strcmp(root,"/")||
       !realpath(argv[1],app_path)||strcmp(argv[1],app_path)||getppid()<=1||fstat(STDIN_FILENO,&channel)||
       !(S_ISFIFO(channel.st_mode)||S_ISSOCK(channel.st_mode)))return 2;
    NSString *prefix=[@(root) stringByAppendingString:@"/"],*location=@(app_path);
    if(![location hasPrefix:prefix])return 2;
    NSArray *parts=[[location substringFromIndex:prefix.length] pathComponents];
    if(parts.count!=2||![parts[0] hasPrefix:@"cliprelay-complete-app-"]||![parts[1] isEqualToString:@"ClipRelay.app"])return 2;
    char *end=nullptr;long port=strtol(argv[2],&end,10);if(!end||*end||port<1024||port>65535)return 2;
    NSURL *url=[NSURL fileURLWithPath:location];NSBundle *bundle=[NSBundle bundleWithURL:url];
    if(![bundle.bundleIdentifier isEqualToString:@"com.cliprelay.desktop"]||
       ![[bundle objectForInfoDictionaryKey:@"CFBundleExecutable"] isEqualToString:@"ClipRelay"]||
       [NSRunningApplication runningApplicationsWithBundleIdentifier:@"com.cliprelay.desktop"].count)return 2;
    expected_path=[location stringByAppendingPathComponent:@"Contents/MacOS/ClipRelay"];
    owner=getppid();deadline=std::chrono::steady_clock::now()+std::chrono::seconds(180);
    NSWorkspaceOpenConfiguration *configuration=[NSWorkspaceOpenConfiguration configuration];
    configuration.activates=YES;configuration.createsNewApplicationInstance=YES;configuration.addsToRecentItems=NO;
    configuration.arguments=@[[NSString stringWithFormat:@"--remote-debugging-port=%ld",port],@"--remote-debugging-address=127.0.0.1"];
    NSMutableDictionary *environment=[NSMutableDictionary dictionary];NSDictionary *current=NSProcessInfo.processInfo.environment;
    for(NSString *key in @[@"PATH",@"HOME",@"TMPDIR",@"RUNNER_TEMP"]){if(current[key])environment[key]=current[key];}
    configuration.environment=environment;
    [NSWorkspace.sharedWorkspace openApplicationAtURL:url configuration:configuration completionHandler:^(NSRunningApplication *running,NSError *error){
      if(error||!running||![running.bundleURL.path isEqualToString:location]){emit(@{@"event":@"error",@"code":@"APP_LAUNCH_FAILED"});exit(3);}
      application=running;
      if(proc_pidinfo(running.processIdentifier,PROC_PIDTBSDINFO,0,&original,sizeof original)!=sizeof original||!owned()){
        emit(@{@"event":@"error",@"code":@"APP_IDENTITY_INVALID"});exit(3);
      }
      emit(@{@"event":@"ready",@"pid":@(running.processIdentifier),@"parentPid":@(original.pbi_ppid),
        @"bundleIdentifier":running.bundleIdentifier,@"launchedThroughNSWorkspace":@YES,@"owned":@YES});
      std::thread([]{
        char line[64];
        while(fgets(line,sizeof line,stdin)){
          @autoreleasepool {
          NSString *command=[@(line) stringByTrimmingCharactersInSet:NSCharacterSet.newlineCharacterSet];
          dispatch_async(dispatch_get_main_queue(),^{
            if([command isEqualToString:@"quit"])close_owned();
            else if([@[@"inspect",@"menu",@"host",@"paired",@"permissions"] containsObject:command])inspect(command);
            else{emit(@{@"event":@"error",@"code":@"COMMAND_INVALID"});close_owned();}
          });
          }
        }
        dispatch_async(dispatch_get_main_queue(),^{close_owned();});
      }).detach();
    }];
    [NSTimer scheduledTimerWithTimeInterval:.1 repeats:YES block:^(NSTimer *timer){
      (void)timer;const auto now=std::chrono::steady_clock::now();
      if(application.terminated){emit(@{@"event":@"closed",@"terminated":@YES,@"forced":@(forced)});exit(closing&&!forced?0:4);}
      if(getppid()!=owner||now>=deadline)close_owned();
      if(closing&&now-close_at>std::chrono::seconds(8)&&owned()){forced=true;[application forceTerminate];}
      if(closing&&now-close_at>std::chrono::seconds(12)){emit(@{@"event":@"error",@"code":@"APP_CLEANUP_TIMEOUT"});exit(4);}
    }];
    [NSRunLoop.mainRunLoop run];
  }
}
