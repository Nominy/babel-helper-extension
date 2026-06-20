// @ts-nocheck

const EXTENSION_COMMAND_MESSAGE_TYPE = 'babel-helper-command';
const AUTO_INSERT_SEGMENT_COMMAND = 'auto-insert-segment';

function sendCommandToTab(tabId, command) {
  if (!Number.isFinite(Number(tabId))) {
    return;
  }

  chrome.tabs.sendMessage(
    Number(tabId),
    {
      type: EXTENSION_COMMAND_MESSAGE_TYPE,
      command
    },
    () => {
      void chrome.runtime.lastError;
    }
  );
}

function sendCommandToActiveTab(command) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (chrome.runtime.lastError) {
      return;
    }

    for (const tab of Array.isArray(tabs) ? tabs : []) {
      sendCommandToTab(tab && tab.id, command);
    }
  });
}

function handleCommand(command, tab) {
  if (command !== AUTO_INSERT_SEGMENT_COMMAND) {
    return;
  }

  if (tab && Number.isFinite(Number(tab.id))) {
    sendCommandToTab(tab.id, command);
    return;
  }

  sendCommandToActiveTab(command);
}

if (typeof chrome !== 'undefined' && chrome.commands && chrome.tabs) {
  chrome.commands.onCommand.addListener(handleCommand);
}
