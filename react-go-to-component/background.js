const NATIVE_HOST = 'com.react_goto_component.open_in_vscode';

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'OPEN_COMPONENT') {
    const comp = msg.component;
    if (!comp) return;
    const filePath = `${msg.projectRoot}${comp.fileName}:${comp.line}:${comp.col}`;
    chrome.runtime.sendNativeMessage(NATIVE_HOST, { cmd: 'open', file: filePath }, () => {
      if (chrome.runtime.lastError) {
        console.error('Native messaging error:', chrome.runtime.lastError.message);
      }
    });
  }

  if (msg.type === 'READ_SOURCE') {
    chrome.runtime.sendNativeMessage(NATIVE_HOST, {
      cmd: 'read',
      file: msg.file,
      line: msg.line,
      context: msg.context || 5,
      hints: msg.hints || []
    }, (resp) => {
      if (chrome.runtime.lastError) {
        sendResponse({ success: false, error: chrome.runtime.lastError.message });
      } else {
        sendResponse(resp);
      }
    });
    return true; // keep sendResponse channel open for async reply
  }
});
