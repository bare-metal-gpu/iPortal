// Offline only: compose and serialize; never play HID events.
#import <Foundation/Foundation.h>
#import <CoreGraphics/CoreGraphics.h>
#import <dlfcn.h>
@protocol Delta <NSObject>
+ (id)eventStreamWithEventActions:(void(^)(id))block;
+ (id)touchScreenDigitizerSender;
- (void)composeWithSender:(id)sender actionBlock:(void(^)(id))block;
- (void)setGsScreenPointSize:(CGSize)size;
- (void)setGsScreenScaleFactor:(double)scale;
- (void)touchDown:(CGPoint)point;
- (void)moveToPoint:(CGPoint)point duration:(double)duration;
- (void)liftUp:(CGPoint)point;
- (NSArray *)events;
- (void)setEvents:(NSArray *)events;
- (NSData *)dataRepresentation;
- (id)senderProperties;
- (unsigned long long)senderID;
@end
int main(void){@autoreleasepool{
  NSCAssert(dlopen("/System/Library/PrivateFrameworks/Recap.framework/Recap",RTLD_LAZY),@"Recap available");
  Class<Delta> cls=(Class<Delta>)NSClassFromString(@"RCPSyntheticEventStream");
  Class<Delta> senderCls=(Class<Delta>)NSClassFromString(@"RCPEventSenderProperties");id<Delta> sender=[senderCls touchScreenDigitizerSender];
  NSUInteger previous=0;
  for(int phase=0;phase<4;phase++){
    id<Delta> stream=[cls eventStreamWithEventActions:^(id<Delta>c){[c composeWithSender:sender actionBlock:^(id<Delta>s){
      [s setGsScreenPointSize:CGSizeMake(402,874)];[s setGsScreenScaleFactor:3];[s touchDown:CGPointMake(150,350)];
      for(int i=1;i<=MIN(phase,2);i++)[s moveToPoint:CGPointMake(150+i*50,350) duration:0.01];
      if(phase==3)[s liftUp:CGPointMake(250,350)];
    }];}];
    NSArray *all=stream.events;NSCAssert(all.count>previous,@"new events exist");
    NSArray *delta=phase==3?@[all.lastObject]:[all subarrayWithRange:NSMakeRange(previous,all.count-previous)];previous=all.count;
    for(id<Delta> event in delta)NSCAssert([[event senderProperties] senderID]==sender.senderID,@"stable sender identity");
    [stream setEvents:delta];NSData *data=stream.dataRepresentation;NSCAssert(data.length>100,@"serializes delta");
    NSLog(@"phase=%d prefix=%lu delta=%lu bytes=%lu sender=%llu",phase,(unsigned long)previous,(unsigned long)delta.count,(unsigned long)data.length,sender.senderID);
    NSLog(@"delta=%@",delta);
    if(phase==0)NSCAssert(delta.count==1,@"one down");
    if(phase==3)NSCAssert(delta.count==1,@"one up");
  }
}return 0;}
