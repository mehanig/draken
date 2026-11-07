/* Native menu-bar helper, run by /usr/bin/osascript -l JavaScript.
 * No Apple Events to other apps, shell commands, provider state or network access. */
ObjC.import('AppKit');
ObjC.import('Foundation');

function run() {
  var environment = $.NSProcessInfo.processInfo.environment;
  var statePath = ObjC.unwrap(environment.objectForKey('DRAKEN_TRAY_STATE'));
  var assets = ObjC.unwrap(environment.objectForKey('DRAKEN_TRAY_ASSETS'));
  var app = $.NSApplication.sharedApplication;
  app.setActivationPolicy($.NSApplicationActivationPolicyAccessory);
  var tray = $.NSStatusBar.systemStatusBar.statusItemWithLength($.NSVariableStatusItemLength);
  var menu = $.NSMenu.alloc.init;
  menu.autoenablesItems = false;
  var items = {}, lastPhase = '', timer;
  function emit(value) {
    $.NSFileHandle.fileHandleWithStandardOutput.writeData($(JSON.stringify(value) + '\n').dataUsingEncoding($.NSUTF8StringEncoding));
  }
  function update() {
    var bytes = $.NSData.dataWithContentsOfFile($(statePath));
    if (Number(bytes.length) > 16384) throw new Error('Invalid tray state');
    var state = JSON.parse(ObjC.unwrap($.NSString.alloc.initWithDataEncoding(bytes, $.NSUTF8StringEncoding)));
    if (state.quit || Math.abs(Date.now() - state.updated) > 15000) { app.terminate(null); return; }
    if (state.version !== 1 || ['running', 'stopped', 'starting', 'stopping', 'error'].indexOf(state.phase) < 0) throw new Error('Invalid tray state');
    tray.button.toolTip = $(state.title + '\n' + state.detail);
    items.status.title = $(state.title);
    items.detail.title = $(state.detail || 'Server connectivity only — not model readiness');
    items.open.enabled = !!state.canOpen;
    items.start.enabled = !!state.canStart;
    items.stop.enabled = !!state.canStop;
    items.quit.title = $(state.owned ? 'Quit tray and stop Draken' : 'Quit tray (leave server running)');
    if (lastPhase !== state.phase) {
      var image = $.NSImage.alloc.initWithContentsOfFile($(assets + '/' + state.phase + '.png'));
      image.size = $.NSMakeSize(20, 20);
      image.template = false;
      tray.button.image = image;
      lastPhase = state.phase;
    }
  }
  ObjC.registerSubclass({ name: 'DrakenTrayDelegate', superclass: 'NSObject', methods: {
    'clicked:': { types: ['void', ['id']], implementation: function(sender) {
      emit({ type: 'action', action: ObjC.unwrap(sender.representedObject) });
    } },
    'tick:': { types: ['void', ['id']], implementation: function() {
      try { update(); } catch (error) { app.terminate(null); }
    } }
  } });
  var delegate = $.DrakenTrayDelegate.alloc.init;
  function item(id, title, enabled) {
    var value = $.NSMenuItem.alloc.initWithTitleActionKeyEquivalent($(title), enabled ? 'clicked:' : null, $(''));
    value.target = delegate;
    value.representedObject = $(id);
    value.enabled = enabled;
    items[id] = value;
    menu.addItem(value);
  }
  item('status', 'Draken — Starting', false);
  item('detail', 'Checking server', false);
  menu.addItem($.NSMenuItem.separatorItem);
  item('open', 'Open Draken', true);
  item('start', 'Start Draken (current settings)', true);
  item('stop', 'Stop Draken (ends active calls)', true);
  menu.addItem($.NSMenuItem.separatorItem);
  item('quit', 'Quit tray', true);
  tray.menu = menu;
  update();
  timer = $.NSTimer.timerWithTimeIntervalTargetSelectorUserInfoRepeats(0.5, delegate, 'tick:', null, true);
  $.NSRunLoop.mainRunLoop.addTimerForMode(timer, $.NSRunLoopCommonModes);
  app.finishLaunching;
  emit({ type: 'ready' });
  app.run;
}
