const PAGE_A_PATH = 'pageA.html';

async function focusOrOpenPageA() {
  const url = chrome.runtime.getURL(PAGE_A_PATH);
  const tabs = await chrome.tabs.query({ url });
  if (tabs.length > 0) {
    await chrome.tabs.update(tabs[0].id, { active: true });
    await chrome.windows.update(tabs[0].windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url });
  }
}

chrome.action.onClicked.addListener(() => {
  focusOrOpenPageA();
});
