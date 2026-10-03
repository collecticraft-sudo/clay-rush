// joycon-bridge: native CoreBluetooth helper of Clay Rush (docs/native-bridge.md).
//
// A productised version of the hardware-verified probe of 2026-09-30 (scan, connect in 0.6 s, discovery, init sequence
// acknowledged, 485 input packets in 14.5 s, always 63 bytes). It exists because Chrome's Web Bluetooth chooser listed no
// device on the owner's Mac. server.js spawns it lazily and speaks to it over pipes:
//
//   stdout, one JSON object per line, flushed after every line:
//     {"type":"hello","version":1}
//     {"type":"status","state":"idle|scanning|connecting|discovering|initialising|streaming|disconnected|error",
//        "code":"...","message":"...","side":"L|R","warning":"...","dropped":N}     (code only with state error)
//     {"type":"advert","side":"L|R","pid":8294,"rssi":-40,"host":"00 00 00 00 00 00","pairing":true}
//     {"type":"report","t":<helper monotonic ms>,"hex":"<126 hex chars>"}
//     {"type":"response","hex":"..."}
//   stdin, one JSON object per line:
//     {"cmd":"connect","side":"R|L|any","scanSeconds":45,"keepAliveHz":1,"mask":183,"pairingOnly":false}
//     {"cmd":"disconnect"}   {"cmd":"rumble","id":3}   {"cmd":"quit"}
//
// Rules this file keeps:
//   * `--version` and `--selftest` never create a CBCentralManager (macOS kills a process that touches Bluetooth without
//     permission). The manager is created by the first `connect` command, not before.
//   * One connection attempt per `connect` command, no retry loop of any kind: the controller refuses rapid repeated
//     connects and the JavaScript state machine owns the cooldown rules.
//   * Only adverts with company id 0x0553 and product id 0x2066/0x2067 are ever looked at; every other device is ignored
//     silently and never printed or logged. Host-address bytes of a bonded controller are never printed (only a flag).
//   * Writes go to the command characteristic 649d4ac9-... only. The firmware-update channel and ...7fdf are never touched.
//   * Exit code 0 on `quit`, on stdin EOF (the server died) and on SIGTERM/SIGINT, after cancelling the peripheral connection.
//
// Everything that needs a real controller is UNVERIFIED-ON-HARDWARE for this productised file (the probe it derives from is
// verified): the collection window, the pairing-mode preference, the keep-alive (the probe streamed only 14.5 s) and the
// error mapping. Build: bridge/build.sh (clang, Objective-C, ARC).
//
// Which advert is connected to (decided 2026-09-30 after the owner's probe connected to a zero-host advert without any problem):
// adverts whose host-address bytes are all zero (pairing mode, SYNC held) are PREFERRED. The first qualifying advert starts a
// kCollectWindowS window; when it ends the strongest pairing-mode advert wins, and if none appeared the strongest matching advert
// is connected to anyway (a controller that still advertises towards its bonded console may be connectable too; whether it is
// is UNVERIFIED-ON-HARDWARE). "pairingOnly":true restores the strict rule (only pairing-mode adverts qualify), an explicit option.

#import <Foundation/Foundation.h>
#import <CoreBluetooth/CoreBluetooth.h>
#include <errno.h>
#include <signal.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

#define BRIDGE_PROTOCOL_VERSION 1

// ------------------------------------------------------------------------------------------------------------------
// Constants (docs/joycon2-protocol.md sections 3 to 5, hardware-findings.md)

static const int kCompanyId = 0x0553;        // Nintendo's Bluetooth SIG id as CoreBluetooth reports it
static const int kPidRight = 0x2066;
static const int kPidLeft = 0x2067;
static const int kMinRssi = -85;             // weaker adverts are ignored (a neighbour's controller, or a fringe reading)
static const double kCollectWindowS = 1.5;   // collect adverts this long after the first qualifying one, then pick the strongest
static const double kConnectTimeoutS = 20.0;
static const double kDiscoveryTimeoutS = 15.0;
static const double kInitTimeoutS = 12.0;    // after the init sequence has started: the input subscription must be confirmed
static const double kReadyTimeoutS = 30.0;   // Bluetooth must report "powered on" within this long (a permission prompt may be open)
static const double kDefaultScanS = 45.0;
static const double kWriteSpacingS = 0.1;    // minimum gap between two writes (CoreBluetooth may drop bursts), same as the game
static const double kKeepAliveIdleRatio = 0.9;  // keep-alive only when no write happened for 90 % of the interval (game: 900 of 1000 ms)
static const int kDefaultMask = 0xB7;
static const size_t kReportLength = 63;
static const size_t kMaxLine = 16384;

static NSString *const kUuidInput = @"ab7de9be-89fe-49ad-828f-118f09df7fd2";
static NSString *const kUuidCommand = @"649d4ac9-8eb7-4e6c-af44-1ea54fe5f005";
static NSString *const kUuidResponse = @"c765a961-d9d8-4d36-a20a-5315b111836a";
static NSString *const kUuidVibrationLeft = @"289326cb-a471-485d-a8f4-240c14f18241";
static NSString *const kUuidVibrationRight = @"fa19b0fb-cd1f-46a7-84a1-bbb09e00c149";

static double gStartUptime = 0;

static double BridgeUptime(void) {
    return [NSProcessInfo processInfo].systemUptime;  // monotonic, seconds
}

// ------------------------------------------------------------------------------------------------------------------
// Pure helpers (covered by --selftest, no Bluetooth involved)

static NSString *BridgeHex(NSData *d) {
    static const char digits[] = "0123456789abcdef";
    const uint8_t *b = d.bytes;
    NSMutableData *out = [NSMutableData dataWithLength:d.length * 2];
    char *o = out.mutableBytes;
    for (NSUInteger i = 0; i < d.length; i++) {
        o[2 * i] = digits[b[i] >> 4];
        o[2 * i + 1] = digits[b[i] & 15];
    }
    return [[NSString alloc] initWithData:out encoding:NSASCIIStringEncoding];
}

static NSString *BridgeJSONQuote(NSString *s) {
    NSMutableString *out = [NSMutableString stringWithString:@"\""];
    for (NSUInteger i = 0; i < s.length; i++) {
        unichar ch = [s characterAtIndex:i];
        switch (ch) {
            case '"': [out appendString:@"\\\""]; break;
            case '\\': [out appendString:@"\\\\"]; break;
            case '\n': [out appendString:@"\\n"]; break;
            case '\r': [out appendString:@"\\r"]; break;
            case '\t': [out appendString:@"\\t"]; break;
            default:
                if (ch < 0x20) [out appendFormat:@"\\u%04x", ch];
                else [out appendString:[NSString stringWithCharacters:&ch length:1]];
        }
    }
    [out appendString:@"\""];
    return out;
}

static NSData *BridgeFrame(uint8_t cmd, uint8_t sub, const uint8_t *payload, size_t n) {
    NSMutableData *d = [NSMutableData dataWithCapacity:8 + n];
    const uint8_t header[8] = {cmd, 0x91, 0x01, sub, 0x00, (uint8_t)n, 0x00, 0x00};
    [d appendBytes:header length:8];
    [d appendBytes:payload length:n];
    return d;
}

// Protocol 5.2 frames. The LED frame doubles as the keep-alive (protocol 5.5), exactly like ble-transport.js.
static NSData *BridgeFrameLED(uint8_t mask) {
    const uint8_t p[8] = {mask, 0, 0, 0, 0, 0, 0, 0};
    return BridgeFrame(0x09, 0x07, p, 8);
}
static NSData *BridgeFrameFeatureSet(uint8_t mask) {
    const uint8_t p[4] = {mask, 0, 0, 0};
    return BridgeFrame(0x0C, 0x02, p, 4);
}
static NSData *BridgeFrameFeatureEnable(uint8_t mask) {
    const uint8_t p[4] = {mask, 0, 0, 0};
    return BridgeFrame(0x0C, 0x04, p, 4);
}
static NSData *BridgeFrameVibrate(uint8_t preset) {
    const uint8_t p[4] = {preset, 0, 0, 0};
    return BridgeFrame(0x0A, 0x02, p, 4);
}

typedef struct {
    int pid;
    BOOL hostKnown;
    BOOL pairing;  // host-address bytes all zero: the controller is in pairing mode (SYNC held)
} BridgeAdvert;

/// Manufacturer data as CoreBluetooth gives it: idx 0-1 company id (LE), idx 7-8 product id (LE), idx 12-17 host address.
static BOOL BridgeParseAdvert(NSData *md, BridgeAdvert *out) {
    if (![md isKindOfClass:[NSData class]] || md.length < 9) return NO;
    const uint8_t *b = md.bytes;
    if ((b[0] | (b[1] << 8)) != kCompanyId) return NO;
    int pid = b[7] | (b[8] << 8);
    if (pid != kPidRight && pid != kPidLeft) return NO;
    out->pid = pid;
    out->hostKnown = md.length >= 18;
    out->pairing = NO;
    if (out->hostKnown) {
        BOOL zero = YES;
        for (int i = 12; i < 18; i++) if (b[i] != 0) zero = NO;
        out->pairing = zero;
    }
    return YES;
}

typedef struct {
    int rssi;
    BOOL pairing;
} BridgeCandidateInfo;

/// Is this advert one the session looks at at all: the wanted side ('R', 'L' or 'A' for any) and a usable signal (127 = "not available").
static BOOL BridgeAdvertVisible(const BridgeAdvert *a, char wantSide, int rssi) {
    if ((wantSide == 'R' && a->pid != kPidRight) || (wantSide == 'L' && a->pid != kPidLeft)) return NO;
    return rssi != 127 && rssi >= kMinRssi;
}

/// Does an advert take part in the choice? By default every matching advert does (pairing-mode ones are preferred later, by
/// BridgeBestCandidate); with pairingOnly only adverts in pairing mode (host address all zero) qualify.
static BOOL BridgeAdvertQualifies(BOOL pairing, BOOL pairingOnly) {
    return pairing || !pairingOnly;
}

/// Index of the best candidate: pairing-mode adverts first, then the strongest RSSI; weaker than kMinRssi never qualifies.
static NSInteger BridgeBestCandidate(const BridgeCandidateInfo *c, NSUInteger n) {
    NSInteger best = -1;
    for (NSUInteger i = 0; i < n; i++) {
        if (c[i].rssi < kMinRssi || c[i].rssi == 127) continue;
        if (best < 0) { best = (NSInteger)i; continue; }
        const BridgeCandidateInfo *b = &c[best];
        if ((c[i].pairing && !b->pairing) || (c[i].pairing == b->pairing && c[i].rssi > b->rssi)) best = (NSInteger)i;
    }
    return best;
}

static double BridgeClamp(id value, double lo, double hi, double fallback) {
    if (![value isKindOfClass:[NSNumber class]]) return fallback;
    double v = [value doubleValue];
    if (v != v) return fallback;  // NaN
    return v < lo ? lo : (v > hi ? hi : v);
}

// JSON builders (pure strings, so --selftest can compare them with literals)

static NSString *BridgeHelloJSON(void) {
    return [NSString stringWithFormat:@"{\"type\":\"hello\",\"version\":%d}", BRIDGE_PROTOCOL_VERSION];
}

static NSString *BridgeStatusJSON(NSString *state, NSString *code, NSString *message, NSString *side, NSString *warning, long dropped) {
    NSMutableString *s = [NSMutableString stringWithFormat:@"{\"type\":\"status\",\"state\":%@", BridgeJSONQuote(state)];
    if (code.length) [s appendFormat:@",\"code\":%@", BridgeJSONQuote(code)];
    if (warning.length) [s appendFormat:@",\"warning\":%@", BridgeJSONQuote(warning)];
    if (message.length) [s appendFormat:@",\"message\":%@", BridgeJSONQuote(message)];
    if (side.length) [s appendFormat:@",\"side\":%@", BridgeJSONQuote(side)];
    if (dropped > 0) [s appendFormat:@",\"dropped\":%ld", dropped];
    [s appendString:@"}"];
    return s;
}

static NSString *BridgeAdvertJSON(int pid, int rssi, BOOL pairing) {
    // The bonded host address of a controller is somebody's console: only a flag leaves this process, never the bytes.
    return [NSString stringWithFormat:@"{\"type\":\"advert\",\"side\":\"%s\",\"pid\":%d,\"rssi\":%d,\"host\":\"%s\",\"pairing\":%s}",
            pid == kPidRight ? "R" : "L", pid, rssi, pairing ? "00 00 00 00 00 00" : "non-zero", pairing ? "true" : "false"];
}

static NSString *BridgeReportJSON(double tMs, NSString *hex) {
    return [NSString stringWithFormat:@"{\"type\":\"report\",\"t\":%.3f,\"hex\":\"%@\"}", tMs, hex];
}

static NSString *BridgeResponseJSON(NSString *hex) {
    return [NSString stringWithFormat:@"{\"type\":\"response\",\"hex\":\"%@\"}", hex];
}

// --- stdout: one line per object, flushed

static BOOL gOutputBroken = NO;

static void BridgeEmit(NSString *line) {
    NSData *d = [[line stringByAppendingString:@"\n"] dataUsingEncoding:NSUTF8StringEncoding];
    if (fwrite(d.bytes, 1, d.length, stdout) != d.length || fflush(stdout) != 0) gOutputBroken = YES;
}

// --- stdin line splitting

@interface BridgeLineBuffer : NSObject
@property(strong) NSMutableData *pending;
@property BOOL overflowed;
- (NSArray<NSString *> *)feed:(const char *)bytes length:(size_t)n;
@end

@implementation BridgeLineBuffer
- (instancetype)init {
    self = [super init];
    _pending = [NSMutableData data];
    return self;
}
- (NSArray<NSString *> *)feed:(const char *)bytes length:(size_t)n {
    NSMutableArray<NSString *> *lines = [NSMutableArray array];
    for (size_t i = 0; i < n; i++) {
        if (bytes[i] == '\n') {
            if (!self.overflowed && self.pending.length > 0) {
                NSString *line = [[NSString alloc] initWithData:self.pending encoding:NSUTF8StringEncoding];
                if (line) [lines addObject:line];
            }
            self.overflowed = NO;
            self.pending.length = 0;
        } else if (!self.overflowed) {
            if (self.pending.length >= kMaxLine) {
                self.overflowed = YES;  // a line longer than any command: drop it up to the next newline
                self.pending.length = 0;
            } else {
                [self.pending appendBytes:&bytes[i] length:1];
            }
        }
    }
    return lines;
}
@end

// ------------------------------------------------------------------------------------------------------------------
// The bridge

@interface BridgeCandidate : NSObject
@property(strong) CBPeripheral *peripheral;
@property int rssi;
@property int pid;
@property BOOL pairing;
@end
@implementation BridgeCandidate
@end

@interface Bridge : NSObject <CBCentralManagerDelegate, CBPeripheralDelegate>
@property(strong) CBCentralManager *central;   // created by the first connect command, never before
@property(strong) CBPeripheral *target;
@property(strong) CBPeripheral *lingering;     // a peripheral whose connection is being cancelled: kept alive until the callback
@property(strong) CBCharacteristic *inChar, *cmdChar, *rspChar;
@property(strong) NSMutableDictionary<NSString *, BridgeCandidate *> *candidates;
@property(strong) NSMutableSet<NSString *> *advSeen;
@property(strong) BridgeLineBuffer *lines;
@property(copy) NSString *state;
@property(copy) NSString *sideReported;
@property BOOL active;        // a connect command is being served
@property BOOL exiting;
@property NSUInteger attempt; // generation: every timer of an older session is ignored
// session parameters
@property char wantSide;      // 'R', 'L' or 'A' (any)
@property double scanSeconds;
@property double keepAliveHz;
@property uint8_t mask;
@property BOOL pairingOnly;
// session progress
@property BOOL pendingStart;  // waiting for Bluetooth to become ready
@property BOOL scanning;
@property BOOL collecting;
@property BOOL sawNonPairing;
@property BOOL targetPairing;  // the chosen advert was in pairing mode (host address all zero)
@property int pendingServices;
@property double writeNotBefore;
@property double lastWriteAt;
@property double lastRumbleAt;
@property long dropped;
@end

@implementation Bridge

- (instancetype)init {
    self = [super init];
    _state = @"idle";
    _candidates = [NSMutableDictionary dictionary];
    _advSeen = [NSMutableSet set];
    _lines = [BridgeLineBuffer new];
    _wantSide = 'A';
    _mask = (uint8_t)kDefaultMask;
    _pairingOnly = NO;
    return self;
}

// --- output helpers

- (void)setState:(NSString *)state code:(NSString *)code message:(NSString *)message {
    self.state = state;
    BridgeEmit(BridgeStatusJSON(state, code, message, self.sideReported, nil, 0));
}

- (void)warn:(NSString *)warning message:(NSString *)message {
    BridgeEmit(BridgeStatusJSON(self.state, nil, message, self.sideReported, warning, self.dropped));
}

- (void)after:(double)seconds attempt:(NSUInteger)att do:(void (^)(void))block {
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(seconds * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
        if (att == self.attempt && self.active) block();
    });
}

static NSString *BridgeErrorText(NSError *e) {
    return e ? [NSString stringWithFormat:@"%@ (%@ %ld)", e.localizedDescription, e.domain, (long)e.code] : @"no error details";
}

/// A failed connect to an advert that was not in pairing mode says so: the next attempt should hold SYNC.
- (NSString *)connectFailText:(NSString *)base {
    return self.targetPairing ? base : [base stringByAppendingString:@"; the Joy-Con was not in pairing mode, hold the SYNC button until the lights sweep and try again"];
}

// --- session end (every path)

- (void)endSessionCancelling:(BOOL)cancel {
    BOOL wasScanning = self.scanning;
    self.active = NO;
    self.attempt++;
    self.scanning = NO;
    self.collecting = NO;
    self.pendingStart = NO;
    if (wasScanning) [self.central stopScan];
    CBPeripheral *t = self.target;
    self.target = nil;
    if (t && cancel) {
        self.lingering = t;
        [self.central cancelPeripheralConnection:t];
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(3 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
            if (self.lingering == t) self.lingering = nil;  // the callback never came: stop holding the peripheral
        });
    }
    self.inChar = nil;
    self.cmdChar = nil;
    self.rspChar = nil;
    [self.candidates removeAllObjects];
    [self.advSeen removeAllObjects];
}

- (void)failWithCode:(NSString *)code message:(NSString *)message {
    if (!self.active) return;
    [self endSessionCancelling:YES];
    [self setState:@"error" code:code message:message];
}

- (void)shutdown {
    if (self.exiting) return;
    self.exiting = YES;
    BOOL hadLink = self.target != nil;
    [self endSessionCancelling:YES];  // cancel the peripheral connection first
    if (!hadLink) exit(0);
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.4 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{ exit(0); });
}

// --- commands

- (void)feedStdin:(const char *)bytes length:(size_t)n {
    for (NSString *line in [self.lines feed:bytes length:n]) [self handleLine:line];
}

- (void)handleLine:(NSString *)line {
    NSData *data = [line dataUsingEncoding:NSUTF8StringEncoding];
    id obj = data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:NULL] : nil;
    if (![obj isKindOfClass:[NSDictionary class]]) {
        [self warn:@"bad_command" message:@"ignored a stdin line that is not a JSON object"];
        return;
    }
    NSString *cmd = obj[@"cmd"];
    if (![cmd isKindOfClass:[NSString class]]) {
        [self warn:@"bad_command" message:@"ignored a command without a \"cmd\" string"];
    } else if ([cmd isEqualToString:@"connect"]) {
        [self startSessionWithCommand:obj];
    } else if ([cmd isEqualToString:@"disconnect"]) {
        [self handleDisconnect];
    } else if ([cmd isEqualToString:@"rumble"]) {
        [self handleRumble:obj];
    } else if ([cmd isEqualToString:@"quit"]) {
        [self shutdown];
    } else {
        [self warn:@"unknown_command" message:@"ignored an unknown command"];
    }
}

- (void)startSessionWithCommand:(NSDictionary *)cmd {
    if (self.active) {
        [self warn:@"busy" message:[NSString stringWithFormat:@"connect ignored: a connection attempt is already running (%@)", self.state]];
        return;
    }
    id sideValue = cmd[@"side"];
    NSString *side = [sideValue isKindOfClass:[NSString class]] ? [sideValue uppercaseString] : @"ANY";
    self.wantSide = [side isEqualToString:@"R"] ? 'R' : ([side isEqualToString:@"L"] ? 'L' : 'A');
    self.scanSeconds = BridgeClamp(cmd[@"scanSeconds"], 5, 120, kDefaultScanS);
    self.keepAliveHz = BridgeClamp(cmd[@"keepAliveHz"], 0, 5, 1);
    self.mask = (uint8_t)BridgeClamp(cmd[@"mask"], 0, 255, kDefaultMask);
    id pairingOnly = cmd[@"pairingOnly"];
    self.pairingOnly = [pairingOnly isKindOfClass:[NSNumber class]] ? [pairingOnly boolValue] : NO;
    self.sideReported = nil;  // set from the chosen advert, corrected by the GATT table: never just the wanted side
    self.sawNonPairing = NO;
    self.targetPairing = YES;
    self.dropped = 0;
    self.writeNotBefore = 0;
    self.lastWriteAt = 0;
    self.lastRumbleAt = 0;
    self.active = YES;
    self.attempt++;
    [self.candidates removeAllObjects];
    [self.advSeen removeAllObjects];
    [self setState:@"scanning" code:nil message:@"waiting for Bluetooth"];
    [self ensureCentralAndScan];
}

- (void)handleDisconnect {
    if (!self.active) return;  // nothing to tear down: stay silent
    [self endSessionCancelling:YES];
    [self setState:@"disconnected" code:nil message:@"disconnected on request"];
}

- (void)handleRumble:(NSDictionary *)cmd {
    if (!self.active || ![self.state isEqualToString:@"streaming"]) return;
    double now = BridgeUptime();
    if (now - self.lastRumbleAt < kWriteSpacingS) return;  // rate limit: 10 per second, like the game
    self.lastRumbleAt = now;
    [self queueWrite:BridgeFrameVibrate((uint8_t)BridgeClamp(cmd[@"id"], 0, 255, 3))];
}

// --- Bluetooth readiness

- (void)ensureCentralAndScan {
    NSUInteger att = self.attempt;
    self.pendingStart = YES;
    if (!self.central) {
        // The first Bluetooth contact of this process: macOS asks for (or checks) the permission of the responsible app here.
        self.central = [[CBCentralManager alloc] initWithDelegate:self queue:nil];
    }
    [self after:kReadyTimeoutS attempt:att do:^{
        if (self.pendingStart) {
            [self failWithCode:@"bluetooth_permission" message:@"Bluetooth did not become ready within 30 s: answer the macOS permission prompt, or check that Bluetooth is on"];
        }
    }];
    if (self.central.state != CBManagerStateUnknown) [self reactToCentralState];  // the state is already known (a later connect); a fresh manager reports it through the delegate
}

- (void)reactToCentralState {
    if (!self.active) return;
    CBCentralManager *c = self.central;
    CBManagerAuthorization auth = CBManager.authorization;
    if (auth == CBManagerAuthorizationDenied || auth == CBManagerAuthorizationRestricted || c.state == CBManagerStateUnauthorized) {
        [self failWithCode:@"bluetooth_permission" message:@"macOS denied Bluetooth access to the app that started this helper (usually Terminal): allow it in System Settings > Privacy & Security > Bluetooth"];
        return;
    }
    switch (c.state) {
        case CBManagerStatePoweredOn:
            if (self.pendingStart) {
                self.pendingStart = NO;
                [self beginScan];
            }
            break;
        case CBManagerStatePoweredOff:
            [self failWithCode:@"bluetooth_off" message:@"Bluetooth is turned off"];
            break;
        case CBManagerStateUnsupported:
            [self failWithCode:@"bluetooth_off" message:@"Bluetooth is not available on this Mac"];
            break;
        default:
            break;  // unknown or resetting: wait for the next update
    }
}

- (void)centralManagerDidUpdateState:(CBCentralManager *)c {
    (void)c;
    [self reactToCentralState];
}

// --- scanning and choosing

- (void)beginScan {
    NSUInteger att = self.attempt;
    self.scanning = YES;
    [self.central scanForPeripheralsWithServices:nil options:@{CBCentralManagerScanOptionAllowDuplicatesKey: @YES}];
    // a second `scanning` status: the first one says "waiting for Bluetooth" (a permission prompt may be open), this one starts the
    // scan time, so the page restarts its own progress timer here
    [self setState:@"scanning" code:nil message:@"scanning for a Joy-Con 2"];
    [self after:self.scanSeconds attempt:att do:^{
        if (!self.scanning) return;
        NSString *why = self.sawNonPairing
            ? @"a Joy-Con 2 was seen but it is not in pairing mode: hold the SYNC button until the lights sweep"
            : [NSString stringWithFormat:@"no Joy-Con 2 advert found within %.0f s: hold the SYNC button until the lights sweep", self.scanSeconds];
        [self failWithCode:@"no_device" message:why];
    }];
}

- (void)centralManager:(CBCentralManager *)c didDiscoverPeripheral:(CBPeripheral *)p advertisementData:(NSDictionary<NSString *, id> *)ad RSSI:(NSNumber *)rssiNumber {
    (void)c;
    if (!self.active || !self.scanning) return;
    BridgeAdvert a;
    if (!BridgeParseAdvert(ad[CBAdvertisementDataManufacturerDataKey], &a)) return;  // every other device: ignored, never printed
    int rssi = rssiNumber.intValue;
    if (!BridgeAdvertVisible(&a, self.wantSide, rssi)) return;
    NSString *id_ = p.identifier.UUIDString;
    NSString *key = [NSString stringWithFormat:@"%@|%d", id_, a.pairing];
    if (![self.advSeen containsObject:key]) {
        [self.advSeen addObject:key];
        BridgeEmit(BridgeAdvertJSON(a.pid, rssi, a.pairing));
    }
    if (!BridgeAdvertQualifies(a.pairing, self.pairingOnly)) {
        self.sawNonPairing = YES;  // only reachable with pairingOnly: the error text then says the controller was seen but not in pairing mode
        return;
    }
    BridgeCandidate *cand = self.candidates[id_];
    if (!cand) {
        cand = [BridgeCandidate new];
        cand.peripheral = p;
        cand.rssi = rssi;
        cand.pairing = a.pairing;
        self.candidates[id_] = cand;
    }
    if (rssi > cand.rssi) cand.rssi = rssi;
    cand.pid = a.pid;
    if (a.pairing) cand.pairing = YES;  // a controller that was in pairing mode at any moment of the window counts as in pairing mode (SYNC released early)
    if (!self.collecting) {
        self.collecting = YES;
        [self after:kCollectWindowS attempt:self.attempt do:^{ [self chooseCandidate]; }];
    }
}

- (void)chooseCandidate {
    if (!self.scanning) return;
    NSArray<BridgeCandidate *> *all = self.candidates.allValues;
    BridgeCandidateInfo *infos = calloc(all.count ? all.count : 1, sizeof(BridgeCandidateInfo));
    for (NSUInteger i = 0; i < all.count; i++) {
        infos[i].rssi = all[i].rssi;
        infos[i].pairing = all[i].pairing;
    }
    NSInteger best = BridgeBestCandidate(infos, all.count);
    free(infos);
    if (best < 0) {
        self.collecting = NO;  // nothing qualified: keep scanning until the scan time is over
        return;
    }
    BridgeCandidate *chosen = all[(NSUInteger)best];
    self.scanning = NO;
    [self.central stopScan];
    self.target = chosen.peripheral;
    self.target.delegate = self;
    self.sideReported = chosen.pid == kPidRight ? @"R" : @"L";
    self.targetPairing = chosen.pairing;
    [self setState:@"connecting" code:nil message:chosen.pairing ? nil : @"no advert in pairing mode appeared: connecting to the strongest Joy-Con 2 advert anyway (it still advertises towards its console)"];
    [self.central connectPeripheral:self.target options:nil];  // the one and only connection attempt of this session
    [self after:kConnectTimeoutS attempt:self.attempt do:^{
        if ([self.state isEqualToString:@"connecting"]) [self failWithCode:@"connect_failed" message:[self connectFailText:@"the connection did not complete within 20 s"]];
    }];
}

// --- connection and discovery

- (void)centralManager:(CBCentralManager *)c didConnectPeripheral:(CBPeripheral *)p {
    (void)c;
    if (!self.active || p != self.target) return;
    [self setState:@"discovering" code:nil message:nil];
    [p discoverServices:nil];
    [self after:kDiscoveryTimeoutS attempt:self.attempt do:^{
        if ([self.state isEqualToString:@"discovering"]) [self failWithCode:@"gatt_failure" message:@"service discovery did not finish within 15 s"];
    }];
}

- (void)centralManager:(CBCentralManager *)c didFailToConnectPeripheral:(CBPeripheral *)p error:(NSError *)e {
    (void)c;
    if (!self.active || p != self.target) return;
    [self failWithCode:@"connect_failed" message:[self connectFailText:BridgeErrorText(e)]];
}

- (void)centralManager:(CBCentralManager *)c didDisconnectPeripheral:(CBPeripheral *)p error:(NSError *)e {
    (void)c;
    if (p == self.lingering) {
        self.lingering = nil;
        if (self.exiting) exit(0);
        return;
    }
    if (!self.active || p != self.target) return;
    NSString *st = self.state;
    if ([st isEqualToString:@"streaming"]) {
        [self failWithCode:@"lost_signal" message:[NSString stringWithFormat:@"the link dropped while streaming: %@", BridgeErrorText(e)]];
    } else if ([st isEqualToString:@"connecting"]) {
        [self failWithCode:@"connect_failed" message:[NSString stringWithFormat:@"the link dropped while connecting: %@", BridgeErrorText(e)]];
    } else {
        [self failWithCode:@"gatt_failure" message:[NSString stringWithFormat:@"the link dropped during setup (%@): %@", st, BridgeErrorText(e)]];
    }
}

- (void)peripheral:(CBPeripheral *)p didDiscoverServices:(NSError *)e {
    if (!self.active || p != self.target) return;
    if (e) {
        [self failWithCode:@"gatt_failure" message:[NSString stringWithFormat:@"service discovery failed: %@", BridgeErrorText(e)]];
        return;
    }
    self.pendingServices = (int)p.services.count;
    if (self.pendingServices == 0) {
        [self failWithCode:@"gatt_failure" message:@"the device exposes no services"];
        return;
    }
    for (CBService *s in p.services) [p discoverCharacteristics:nil forService:s];
}

- (void)peripheral:(CBPeripheral *)p didDiscoverCharacteristicsForService:(CBService *)s error:(NSError *)e {
    if (!self.active || p != self.target) return;
    // Like the probe: a service that cannot be read is skipped, not fatal (the Generic Attribute service is empty). The init below
    // fails with a clear message when the two characteristics it needs are missing.
    if (e) [self warn:@"characteristics_failed" message:[NSString stringWithFormat:@"could not read the characteristics of one service: %@", BridgeErrorText(e)]];
    for (CBCharacteristic *c in s.characteristics) {
        NSString *u = c.UUID.UUIDString.lowercaseString;
        if ([u isEqualToString:kUuidInput]) self.inChar = c;
        else if ([u isEqualToString:kUuidCommand]) self.cmdChar = c;
        else if ([u isEqualToString:kUuidResponse]) self.rspChar = c;
        else if ([u isEqualToString:kUuidVibrationLeft]) self.sideReported = @"L";   // the GATT table beats the advert (protocol 3.2)
        else if ([u isEqualToString:kUuidVibrationRight]) self.sideReported = @"R";
    }
    if (--self.pendingServices == 0) [self startInit];
}

// --- init sequence (exactly the probe: responses, LED, SET, ENABLE, then the input subscription)

- (void)startInit {
    if (!self.inChar || !self.cmdChar) {
        NSString *missing = !self.inChar && !self.cmdChar ? @"input and command" : (!self.inChar ? @"input" : @"command");
        [self failWithCode:@"gatt_failure" message:[NSString stringWithFormat:@"required characteristics missing (%@)", missing]];
        return;
    }
    [self setState:@"initialising" code:nil message:nil];
    NSUInteger att = self.attempt;
    if (self.rspChar) [self.target setNotifyValue:YES forCharacteristic:self.rspChar];  // optional: paces the init, never fatal
    NSData *led = BridgeFrameLED(0x01);
    NSData *set = BridgeFrameFeatureSet(self.mask);
    NSData *enable = BridgeFrameFeatureEnable(self.mask);
    [self after:0.4 attempt:att do:^{ [self queueWrite:led]; }];       // stops the pairing LED sweep: the visible "connected" cue
    [self after:0.9 attempt:att do:^{ [self queueWrite:set]; }];
    [self after:1.4 attempt:att do:^{ [self queueWrite:enable]; }];
    [self after:2.0 attempt:att do:^{
        if (self.inChar) [self.target setNotifyValue:YES forCharacteristic:self.inChar];
    }];
    [self after:kInitTimeoutS attempt:att do:^{
        if ([self.state isEqualToString:@"initialising"]) [self failWithCode:@"gatt_failure" message:@"the input notification subscription was not confirmed"];
    }];
}

- (void)peripheral:(CBPeripheral *)p didUpdateNotificationStateForCharacteristic:(CBCharacteristic *)c error:(NSError *)e {
    if (!self.active || p != self.target) return;
    if (c == self.inChar) {
        if (e) {
            [self failWithCode:@"gatt_failure" message:[NSString stringWithFormat:@"subscribing to the input characteristic failed: %@", BridgeErrorText(e)]];
        } else if (c.isNotifying && [self.state isEqualToString:@"initialising"]) {
            [self setState:@"streaming" code:nil message:nil];
            [self startKeepAlive];
        }
    } else if (c == self.rspChar && e) {
        [self warn:@"response_subscribe_failed" message:[NSString stringWithFormat:@"no command responses: %@", BridgeErrorText(e)]];
    }
}

- (void)peripheral:(CBPeripheral *)p didUpdateValueForCharacteristic:(CBCharacteristic *)c error:(NSError *)e {
    if (!self.active || p != self.target || e || !c.value) return;
    if (c == self.rspChar) {
        BridgeEmit(BridgeResponseJSON(BridgeHex(c.value)));
        return;
    }
    if (c != self.inChar) return;
    if (c.value.length != kReportLength) {
        self.dropped++;
        if (self.dropped == 1 || self.dropped % 100 == 0) {
            [self warn:@"bad_length" message:[NSString stringWithFormat:@"dropped an input notification of %lu bytes (expected 63)", (unsigned long)c.value.length]];
        }
        return;
    }
    BridgeEmit(BridgeReportJSON((BridgeUptime() - gStartUptime) * 1000.0, BridgeHex(c.value)));
}

// --- writes: serial, at least 100 ms apart, command characteristic only

- (void)queueWrite:(NSData *)frame {
    double now = BridgeUptime();
    double at = now > self.writeNotBefore ? now : self.writeNotBefore;
    self.writeNotBefore = at + kWriteSpacingS;
    if (at <= now) {
        [self doWrite:frame];
        return;
    }
    [self after:(at - now) attempt:self.attempt do:^{ [self doWrite:frame]; }];
}

- (void)doWrite:(NSData *)frame {
    if (!self.active || !self.cmdChar || self.target.state != CBPeripheralStateConnected) return;
    [self.target writeValue:frame forCharacteristic:self.cmdChar type:CBCharacteristicWriteWithoutResponse];
    self.lastWriteAt = BridgeUptime();
}

// The same keep-alive as ble-transport.js: the LED frame, when no write happened for 90 % of the interval.
// UNVERIFIED-ON-HARDWARE: the probe streamed for 14.5 s only; whether the link needs this is an open question (UOH-5).
- (void)startKeepAlive {
    if (self.keepAliveHz <= 0) return;
    NSUInteger att = self.attempt;
    double interval = 1.0 / self.keepAliveHz;
    [self after:interval attempt:att do:^{ [self keepAliveTick:att]; }];
}

- (void)keepAliveTick:(NSUInteger)att {
    if (att != self.attempt || !self.active || ![self.state isEqualToString:@"streaming"]) return;
    double interval = 1.0 / self.keepAliveHz;
    if (BridgeUptime() - self.lastWriteAt >= kKeepAliveIdleRatio * interval) [self queueWrite:BridgeFrameLED(0x01)];
    [self after:interval attempt:att do:^{ [self keepAliveTick:att]; }];
}

@end

// ------------------------------------------------------------------------------------------------------------------
// --selftest: pure checks only, no CBCentralManager is ever created

static int gChecks = 0;
static int gFailures = 0;

#define CHECK(cond, what) do { gChecks++; if (!(cond)) { gFailures++; fprintf(stderr, "selftest FAILED: %s\n", what); } } while (0)

static NSData *BridgeTestAdvert(int pid, const uint8_t *host, int company, NSUInteger length) {
    NSMutableData *d = [NSMutableData dataWithLength:length];
    uint8_t *b = d.mutableBytes;
    b[0] = (uint8_t)(company & 0xff);
    b[1] = (uint8_t)(company >> 8);
    if (length > 8) {
        b[2] = 0x01; b[4] = 0x03; b[5] = 0x7e; b[6] = 0x05;
        b[7] = (uint8_t)(pid & 0xff);
        b[8] = (uint8_t)(pid >> 8);
    }
    if (host && length >= 18) memcpy(&b[12], host, 6);
    return d;
}

/// The choice of one session, on synthetic adverts and with the same pure functions the runtime uses: which of `ads` (each with its
/// RSSI) would be connected to after the collection window, or -1. Adverts of one device are not merged here: every entry is its own
/// device, which is how the tests use it.
static NSInteger BridgePickFromAdverts(NSArray<NSData *> *ads, const int *rssis, char wantSide, BOOL pairingOnly) {
    NSMutableArray<NSNumber *> *origin = [NSMutableArray array];
    BridgeCandidateInfo *infos = calloc(ads.count ? ads.count : 1, sizeof(BridgeCandidateInfo));
    NSUInteger n = 0;
    for (NSUInteger i = 0; i < ads.count; i++) {
        BridgeAdvert a;
        if (!BridgeParseAdvert(ads[i], &a)) continue;
        if (!BridgeAdvertVisible(&a, wantSide, rssis[i])) continue;
        if (!BridgeAdvertQualifies(a.pairing, pairingOnly)) continue;
        infos[n].rssi = rssis[i];
        infos[n].pairing = a.pairing;
        [origin addObject:@(i)];
        n++;
    }
    NSInteger best = BridgeBestCandidate(infos, n);
    free(infos);
    return best < 0 ? -1 : origin[(NSUInteger)best].integerValue;
}

static int BridgeSelfTest(void) {
    CHECK([BridgeHex(BridgeFrameLED(0x01)) isEqualToString:@"09910107000800000100000000000000"], "LED frame");
    CHECK([BridgeHex(BridgeFrameFeatureSet(0xB7)) isEqualToString:@"0c91010200040000b7000000"], "feature SET frame");
    CHECK([BridgeHex(BridgeFrameFeatureEnable(0xB7)) isEqualToString:@"0c91010400040000b7000000"], "feature ENABLE frame");
    CHECK([BridgeHex(BridgeFrameVibrate(3)) isEqualToString:@"0a9101020004000003000000"], "vibration preset 3 frame");
    CHECK(BridgeFrameLED(1).length == 16 && BridgeFrameFeatureSet(1).length == 12, "frame lengths");

    const uint8_t zero[6] = {0, 0, 0, 0, 0, 0};
    const uint8_t bonded[6] = {0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff}; // a made-up bonded-host address (any non-zero bytes)
    BridgeAdvert a;
    CHECK(BridgeParseAdvert(BridgeTestAdvert(0x2066, zero, 0x0553, 26), &a) && a.pid == 0x2066 && a.pairing && a.hostKnown, "right advert in pairing mode");
    CHECK(BridgeParseAdvert(BridgeTestAdvert(0x2067, bonded, 0x0553, 26), &a) && a.pid == 0x2067 && !a.pairing && a.hostKnown, "left advert with a bonded host");
    CHECK(BridgeParseAdvert(BridgeTestAdvert(0x2066, zero, 0x0553, 12), &a) && !a.hostKnown && !a.pairing, "short advert: host unknown is not pairing");
    CHECK(!BridgeParseAdvert(BridgeTestAdvert(0x2066, zero, 0x004c, 26), &a), "another company id is ignored");
    CHECK(!BridgeParseAdvert(BridgeTestAdvert(0x2069, zero, 0x0553, 26), &a), "another product id (Pro Controller 2) is ignored");
    CHECK(!BridgeParseAdvert(BridgeTestAdvert(0x2066, zero, 0x0553, 8), &a), "too short to carry a product id");
    CHECK(!BridgeParseAdvert(nil, &a), "no manufacturer data");

    BridgeCandidateInfo strongBonded = {-30, NO}, pairingFar = {-70, YES}, pairingNear = {-45, YES}, tooWeak = {-90, YES}, unavailable = {127, YES};
    BridgeCandidateInfo set1[] = {pairingFar, pairingNear, strongBonded};
    CHECK(BridgeBestCandidate(set1, 3) == 1, "strongest pairing-mode advert wins over a stronger bonded one");
    BridgeCandidateInfo set2[] = {tooWeak, unavailable};
    CHECK(BridgeBestCandidate(set2, 2) == -1, "weaker than -85 dBm and RSSI 127 never qualify");
    BridgeCandidateInfo set3[] = {tooWeak, pairingFar};
    CHECK(BridgeBestCandidate(set3, 2) == 1, "a weak advert is skipped, the next one is chosen");
    CHECK(BridgeBestCandidate(set1, 0) == -1, "no candidates");

    // The preference of 2026-09-30: pairing-mode adverts first, otherwise the strongest matching advert, unless pairingOnly says no.
    {
        NSData *pairNear = BridgeTestAdvert(0x2066, zero, 0x0553, 26);
        NSData *pairFar = BridgeTestAdvert(0x2066, zero, 0x0553, 26);
        NSData *bondedStrong = BridgeTestAdvert(0x2066, bonded, 0x0553, 26);
        NSData *bondedWeak = BridgeTestAdvert(0x2066, bonded, 0x0553, 26);
        NSData *leftPair = BridgeTestAdvert(0x2067, zero, 0x0553, 26);
        NSData *leftBonded = BridgeTestAdvert(0x2067, bonded, 0x0553, 26);
        NSData *foreign = BridgeTestAdvert(0x2066, zero, 0x004c, 26);
        NSData *shortAd = BridgeTestAdvert(0x2066, zero, 0x0553, 12);  // no host bytes: not pairing, but still a Joy-Con advert
        int r1[] = {-50};
        CHECK(BridgePickFromAdverts(@[bondedStrong], r1, 'A', NO) == 0, "default: a lone bonded-host advert is connected to anyway");
        CHECK(BridgePickFromAdverts(@[bondedStrong], r1, 'A', YES) == -1, "pairingOnly: a lone bonded-host advert is never chosen");
        CHECK(BridgePickFromAdverts(@[shortAd], r1, 'A', NO) == 0, "default: an advert without host bytes is connectable (host unknown)");
        int r2[] = {-30, -60};
        CHECK(BridgePickFromAdverts(@[bondedStrong, pairFar], r2, 'A', NO) == 1, "default: the pairing-mode advert wins although the bonded one is stronger");
        CHECK(BridgePickFromAdverts(@[bondedStrong, pairFar], r2, 'A', YES) == 1, "pairingOnly: the pairing-mode advert is chosen");
        int r3[] = {-60, -30};
        CHECK(BridgePickFromAdverts(@[bondedWeak, bondedStrong], r3, 'A', NO) == 1, "default: with no pairing-mode advert the strongest bonded one wins");
        int r4[] = {-40, -55, -70};
        CHECK(BridgePickFromAdverts(@[pairFar, pairNear, bondedStrong], r4, 'A', NO) == 0, "the strongest of several pairing-mode adverts wins");
        int r5[] = {-90, -80};
        CHECK(BridgePickFromAdverts(@[bondedStrong, bondedWeak], r5, 'A', NO) == 1, "an advert weaker than -85 dBm is skipped, the next one qualifies");
        int r6[] = {-90};
        CHECK(BridgePickFromAdverts(@[bondedStrong], r6, 'A', NO) == -1, "default: a lone advert weaker than -85 dBm never qualifies");
        int r7[] = {127, -40};
        CHECK(BridgePickFromAdverts(@[pairNear, bondedWeak], r7, 'A', NO) == 1, "RSSI 127 (not available) is skipped");
        int r8[] = {-40, -50};
        CHECK(BridgePickFromAdverts(@[leftPair, bondedStrong], r8, 'R', NO) == 1, "side R ignores the Left advert");
        CHECK(BridgePickFromAdverts(@[leftBonded, pairNear], r8, 'L', NO) == 0, "side L ignores the Right advert and takes the Left one, bonded or not");
        CHECK(BridgePickFromAdverts(@[foreign], r1, 'A', NO) == -1, "another company id is ignored");
        CHECK(BridgePickFromAdverts(@[], r1, 'A', NO) == -1, "no adverts, no choice");
        CHECK(BridgeAdvertQualifies(YES, NO) && BridgeAdvertQualifies(NO, NO) && BridgeAdvertQualifies(YES, YES) && !BridgeAdvertQualifies(NO, YES), "qualification table of pairingOnly");
    }

    CHECK([BridgeJSONQuote(@"a\"b\\c\n\x01") isEqualToString:@"\"a\\\"b\\\\c\\n\\u0001\""], "JSON escaping");
    CHECK([BridgeHelloJSON() isEqualToString:@"{\"type\":\"hello\",\"version\":1}"], "hello line");
    CHECK([BridgeStatusJSON(@"error", @"no_device", @"x", nil, nil, 0) isEqualToString:@"{\"type\":\"status\",\"state\":\"error\",\"code\":\"no_device\",\"message\":\"x\"}"], "error status line");
    CHECK([BridgeStatusJSON(@"streaming", nil, nil, @"R", nil, 0) isEqualToString:@"{\"type\":\"status\",\"state\":\"streaming\",\"side\":\"R\"}"], "streaming status line");
    CHECK([BridgeStatusJSON(@"streaming", nil, @"m", nil, @"bad_length", 3) isEqualToString:@"{\"type\":\"status\",\"state\":\"streaming\",\"warning\":\"bad_length\",\"message\":\"m\",\"dropped\":3}"], "warning status line");
    CHECK([BridgeAdvertJSON(0x2066, -40, YES) isEqualToString:@"{\"type\":\"advert\",\"side\":\"R\",\"pid\":8294,\"rssi\":-40,\"host\":\"00 00 00 00 00 00\",\"pairing\":true}"], "advert line (pairing)");
    CHECK([BridgeAdvertJSON(0x2067, -61, NO) isEqualToString:@"{\"type\":\"advert\",\"side\":\"L\",\"pid\":8295,\"rssi\":-61,\"host\":\"non-zero\",\"pairing\":false}"], "advert line (bonded host is not printed)");
    CHECK([BridgeReportJSON(12.3456, @"ab") isEqualToString:@"{\"type\":\"report\",\"t\":12.346,\"hex\":\"ab\"}"], "report line");
    CHECK([BridgeResponseJSON(@"0c01") isEqualToString:@"{\"type\":\"response\",\"hex\":\"0c01\"}"], "response line");

    CHECK(BridgeClamp(@200, 5, 120, 45) == 120 && BridgeClamp(@1, 5, 120, 45) == 5 && BridgeClamp(@"x", 5, 120, 45) == 45 && BridgeClamp(nil, 0, 5, 1) == 1, "number clamping");

    BridgeLineBuffer *lb = [BridgeLineBuffer new];
    NSArray<NSString *> *l1 = [lb feed:"{\"a\":1}\n{\"b\"" length:12];
    NSArray<NSString *> *l2 = [lb feed:":2}\n\n" length:5];
    CHECK(l1.count == 1 && [l1[0] isEqualToString:@"{\"a\":1}"] && l2.count == 1 && [l2[0] isEqualToString:@"{\"b\":2}"], "stdin line splitting across chunks");

    return gFailures;
}

// ------------------------------------------------------------------------------------------------------------------
// main

static NSMutableArray *gSources;

static void BridgeInstallSignal(int sig, void (^handler)(void)) {
    signal(sig, SIG_IGN);
    dispatch_source_t s = dispatch_source_create(DISPATCH_SOURCE_TYPE_SIGNAL, (uintptr_t)sig, 0, dispatch_get_main_queue());
    dispatch_source_set_event_handler(s, handler);
    dispatch_resume(s);
    [gSources addObject:s];
}

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        signal(SIGPIPE, SIG_IGN);
        gStartUptime = BridgeUptime();
        if (argc > 1) {
            BOOL version = strcmp(argv[1], "--version") == 0;
            BOOL selftest = strcmp(argv[1], "--selftest") == 0;
            if (!version && !selftest) {
                fprintf(stderr, "usage: joycon-bridge [--version | --selftest]\n(without arguments it serves line-delimited JSON on stdin and stdout)\n");
                return 2;
            }
            BridgeEmit(BridgeHelloJSON());  // no CBCentralManager is created on these two paths
            if (version) return 0;
            int failures = BridgeSelfTest();
            BridgeEmit([NSString stringWithFormat:@"{\"type\":\"selftest\",\"ok\":%s,\"checks\":%d,\"failures\":%d}", failures == 0 ? "true" : "false", gChecks, failures]);
            return failures == 0 ? 0 : 1;
        }

        gSources = [NSMutableArray array];
        Bridge *bridge = [Bridge new];
        BridgeEmit(BridgeHelloJSON());
        BridgeEmit(BridgeStatusJSON(@"idle", nil, nil, nil, nil, 0));

        BridgeInstallSignal(SIGTERM, ^{ [bridge shutdown]; });
        BridgeInstallSignal(SIGINT, ^{ [bridge shutdown]; });

        dispatch_source_t input = dispatch_source_create(DISPATCH_SOURCE_TYPE_READ, STDIN_FILENO, 0, dispatch_get_main_queue());
        dispatch_source_set_event_handler(input, ^{
            char buf[4096];
            ssize_t n = read(STDIN_FILENO, buf, sizeof buf);
            if (n > 0) {
                [bridge feedStdin:buf length:(size_t)n];
                if (gOutputBroken) [bridge shutdown];
            } else if (n == 0 || (errno != EINTR && errno != EAGAIN)) {
                [bridge shutdown];  // stdin closed: the server is gone
            }
        });
        dispatch_resume(input);
        [gSources addObject:input];

        dispatch_main();
    }
    return 0;
}
