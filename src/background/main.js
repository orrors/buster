import audioBufferToWav from 'audiobuffer-to-wav';
import {initStorage, migrateLegacyStorage} from 'storage/init';
import storage, {isStorageReady} from 'storage/storage';
import {
  processAppUse,
  processMessageResponse,
  sendNativeMessage,
  showNotification
} from 'utils/app';
import {
  arrayBufferToBase64,
  executeCode,
  getBrowser,
  getPlatform,
  normalizeAudio,
  scriptsAllowed,
  sliceAudio
} from 'utils/common';
import {clientAppVersion, targetEnv} from 'utils/config';
import {
  captchaGoogleSpeechApiLangCodes,
  recaptchaChallengeUrlRx
} from 'utils/data';

let nativePort;

function getFrameClientPos(index) {
  let currentIndex = -1;
  if (window !== window.top) {
    const siblingWindows = window.parent.frames;
    for (let i = 0; i < siblingWindows.length; i++) {
      if (siblingWindows[i] === window) {
        currentIndex = i;
        break;
      }
    }
  }

  const targetWindow = window.frames[index];
  for (const frame of document.querySelectorAll('iframe')) {
    if (frame.contentWindow === targetWindow) {
      let {left: x, top: y} = frame.getBoundingClientRect();
      const scale = window.devicePixelRatio;

      return {x: x * scale, y: y * scale, currentIndex};
    }
  }
}

async function getFramePos(tabId, frameId, frameIndex) {
  let x = 0;
  let y = 0;

  while (true) {
    frameId = (
      await browser.webNavigation.getFrame({
        tabId,
        frameId
      })
    ).parentFrameId;
    if (frameId === -1) {
      break;
    }

    const [data] = await executeCode(
      `(${getFrameClientPos.toString()})(${frameIndex})`,
      tabId,
      frameId
    );

    frameIndex = data.currentIndex;
    x += data.x;
    y += data.y;
  }

  return {x, y};
}

function initResetCaptcha() {
  const initReset = function (challengeUrl) {
    const script = document.createElement('script');
    script.onload = function (ev) {
      ev.target.remove();
      document.dispatchEvent(
        new CustomEvent('___resetCaptcha', {detail: challengeUrl})
      );
    };
    script.src = chrome.runtime.getURL('/src/scripts/reset.js');
    document.documentElement.appendChild(script);
  };

  const onMessage = function (request) {
    if (request.id === 'resetCaptcha') {
      removeCallbacks();
      initReset(request.challengeUrl);
    }
  };

  const removeCallbacks = function () {
    window.clearTimeout(timeoutId);
    chrome.runtime.onMessage.removeListener(onMessage);
  };

  const timeoutId = window.setTimeout(removeCallbacks, 10000); // 10 seconds

  chrome.runtime.onMessage.addListener(onMessage);
}

async function resetCaptcha(tabId, frameId, challengeUrl) {
  frameId = (await browser.webNavigation.getFrame({tabId, frameId}))
    .parentFrameId;

  if (!(await scriptsAllowed(tabId, frameId))) {
    await showNotification({messageId: 'error_scriptsNotAllowed'});
    return;
  }

  await executeCode(`(${initResetCaptcha.toString()})()`, tabId, frameId);

  await browser.tabs.sendMessage(
    tabId,
    {
      id: 'resetCaptcha',
      challengeUrl
    },
    {frameId}
  );
}

function challengeRequestCallback(details) {
  const url = new URL(details.url);
  if (url.searchParams.get('hl') !== 'en') {
    url.searchParams.set('hl', 'en');
    return {redirectUrl: url.toString()};
  }
}

async function setChallengeLocale() {
  const {loadEnglishChallenge, simulateUserInput} = await storage.get([
    'loadEnglishChallenge',
    'simulateUserInput'
  ]);

  if (loadEnglishChallenge || simulateUserInput) {
    if (
      !browser.webRequest.onBeforeRequest.hasListener(challengeRequestCallback)
    ) {
      browser.webRequest.onBeforeRequest.addListener(
        challengeRequestCallback,
        {
          urls: [
            'https://google.com/recaptcha/api2/anchor*',
            'https://google.com/recaptcha/api2/bframe*',
            'https://www.google.com/recaptcha/api2/anchor*',
            'https://www.google.com/recaptcha/api2/bframe*',
            'https://google.com/recaptcha/enterprise/anchor*',
            'https://google.com/recaptcha/enterprise/bframe*',
            'https://www.google.com/recaptcha/enterprise/anchor*',
            'https://www.google.com/recaptcha/enterprise/bframe*',
            'https://recaptcha.net/recaptcha/api2/anchor*',
            'https://recaptcha.net/recaptcha/api2/bframe*',
            'https://www.recaptcha.net/recaptcha/api2/anchor*',
            'https://www.recaptcha.net/recaptcha/api2/bframe*',
            'https://recaptcha.net/recaptcha/enterprise/anchor*',
            'https://recaptcha.net/recaptcha/enterprise/bframe*',
            'https://www.recaptcha.net/recaptcha/enterprise/anchor*',
            'https://www.recaptcha.net/recaptcha/enterprise/bframe*'
          ],
          types: ['sub_frame']
        },
        ['blocking']
      );
    }
  } else if (
    browser.webRequest.onBeforeRequest.hasListener(challengeRequestCallback)
  ) {
    browser.webRequest.onBeforeRequest.removeListener(challengeRequestCallback);
  }
}

function removeRequestOrigin(details) {
  const origin = window.location.origin;
  const headers = details.requestHeaders;
  for (const header of headers) {
    if (header.name.toLowerCase() === 'origin' && header.value === origin) {
      headers.splice(headers.indexOf(header), 1);
      break;
    }
  }

  return {requestHeaders: headers};
}

function addBackgroundRequestListener() {
  if (
    !browser.webRequest.onBeforeSendHeaders.hasListener(removeRequestOrigin)
  ) {
    const urls = [
      'https://google.com/*',
      'https://www.google.com/*',
      'https://recaptcha.net/*',
      'https://www.recaptcha.net/*',
      'https://api.wit.ai/*',
      'https://speech.googleapis.com/*',
      'https://*.speech-to-text.watson.cloud.ibm.com/*',
      'https://*.stt.speech.microsoft.com/*'
    ];

    const extraInfo = ['blocking', 'requestHeaders'];
    if (
      targetEnv !== 'firefox' &&
      Object.values(browser.webRequest.OnBeforeSendHeadersOptions).includes(
        'extraHeaders'
      )
    ) {
      extraInfo.push('extraHeaders');
    }

    browser.webRequest.onBeforeSendHeaders.addListener(
      removeRequestOrigin,
      {
        urls,
        types: ['xmlhttprequest']
      },
      extraInfo
    );
  }
}

function removeBackgroundRequestListener() {
  if (browser.webRequest.onBeforeSendHeaders.hasListener(removeRequestOrigin)) {
    browser.webRequest.onBeforeSendHeaders.removeListener(removeRequestOrigin);
  }
}

async function prepareAudio(audio) {
  const audioBuffer = await normalizeAudio(audio);

  const audioSlice = await sliceAudio({
    audioBuffer,
    start: 1.5,
    end: audioBuffer.duration - 1.5
  });

  return audioBufferToWav(audioSlice);
}

async function getGoogleSpeechApiResult(
  apiKey,
  audioContent,
  language,
  detectAltLanguages
) {
  const data = {
    audio: {
      content: arrayBufferToBase64(audioContent)
    },
    config: {
      encoding: 'LINEAR16',
      languageCode: language,
      model: 'video',
      sampleRateHertz: 16000
    }
  };

  if (!['en-US', 'en-GB'].includes(language) && detectAltLanguages) {
    data.config.model = 'default';
    data.config.alternativeLanguageCodes = ['en-US'];
  }

  const rsp = await fetch(
    `https://speech.googleapis.com/v1p1beta1/speech:recognize?key=${apiKey}`,
    {
      mode: 'cors',
      method: 'POST',
      body: JSON.stringify(data)
    }
  );

  if (rsp.status !== 200) {
    throw new Error(`API response: ${rsp.status}, ${await rsp.text()}`);
  }

  const results = (await rsp.json()).results;
  if (results) {
    return results[0].alternatives[0].transcript.trim();
  }
}

async function transcribeAudio(audioUrl, lang) {
  let solution;

  const audioRsp = await fetch(audioUrl);
  const audioContent = await prepareAudio(await audioRsp.arrayBuffer());

  const {speechService, tryEnglishSpeechModel} = await storage.get([
    'speechService',
    'tryEnglishSpeechModel'
  ]);

  // const {googleSpeechApiKey: apiKey} = await storage.get('googleSpeechApiKey');
  const GOOGLE_API_KEY = 'CHANGE_API_KEY_HERE';
  const language = captchaGoogleSpeechApiLangCodes[lang] || 'en-US';
  solution = await getGoogleSpeechApiResult(
    GOOGLE_API_KEY,
    audioContent,
    language,
    tryEnglishSpeechModel
  );

  if (!solution) {
    if (['witSpeechApiDemo', 'witSpeechApi'].includes(speechService)) {
      showNotification({
        messageId: 'error_captchaNotSolvedWitai',
        timeout: 60000
      });
    } else {
      showNotification({messageId: 'error_captchaNotSolved', timeout: 6000});
    }
  } else {
    return solution;
  }
}

async function processMessage(request, sender) {
  if (request.id === 'notification') {
    showNotification({
      message: request.message,
      messageId: request.messageId,
      title: request.title,
      type: request.type,
      timeout: request.timeout
    });
  } else if (request.id === 'captchaSolved') {
    await processAppUse();
  } else if (request.id === 'transcribeAudio') {
    addBackgroundRequestListener();
    try {
      return await transcribeAudio(request.audioUrl, request.lang);
    } finally {
      removeBackgroundRequestListener();
    }
  } else if (request.id === 'resetCaptcha') {
    await resetCaptcha(sender.tab.id, sender.frameId, request.challengeUrl);
  } else if (request.id === 'getFramePos') {
    return getFramePos(sender.tab.id, sender.frameId, request.frameIndex);
  } else if (request.id === 'getOsScale') {
    let zoom = await browser.tabs.getZoom(sender.tab.id);

    const [[scale, windowWidth]] = await browser.tabs.executeScript(
      sender.tab.id,
      {
        code: `[window.devicePixelRatio, window.innerWidth];`,
        runAt: 'document_start'
      }
    );

    if (targetEnv === 'firefox') {
      // https://bugzilla.mozilla.org/show_bug.cgi?id=1787649

      function getImageElement(url) {
        return new Promise(resolve => {
          const img = new Image();
          img.onload = () => {
            resolve(img);
          };
          img.onerror = () => {
            resolve();
          };
          img.onabort = () => {
            resolve();
          };
          img.src = url;
        });
      }

      const screenshotWidth = (
        await getImageElement(
          await browser.tabs.captureVisibleTab({
            format: 'jpeg',
            quality: 10
          })
        )
      ).naturalWidth;

      if (Math.abs(screenshotWidth / windowWidth - scale * zoom) < 0.005) {
        zoom = 1;
      }
    }

    return scale / zoom;
  } else if (request.id === 'startClientApp') {
    nativePort = browser.runtime.connectNative('org.buster.client');
  } else if (request.id === 'stopClientApp') {
    if (nativePort) {
      nativePort.disconnect();
    }
  } else if (request.id === 'messageClientApp') {
    const message = {
      apiVersion: clientAppVersion,
      ...request.message
    };
    return sendNativeMessage(nativePort, message);
  } else if (request.id === 'openOptions') {
    browser.runtime.openOptionsPage();
  } else if (request.id === 'getPlatform') {
    return getPlatform({fallback: false});
  } else if (request.id === 'getBrowser') {
    return getBrowser();
  } else if (request.id === 'optionChange') {
    await onOptionChange();
  }
}

function onMessage(request, sender, sendResponse) {
  const response = processMessage(request, sender);

  return processMessageResponse(response, sendResponse);
}

async function onOptionChange() {
  await setChallengeLocale();
}

async function onActionButtonClick(tab) {
  await browser.runtime.openOptionsPage();
}

async function onInstall(details) {
  if (
    ['chrome', 'edge', 'opera'].includes(targetEnv) &&
    ['install', 'update'].includes(details.reason)
  ) {
    const tabs = await browser.tabs.query({
      url: ['http://*/*', 'https://*/*'],
      windowType: 'normal'
    });

    for (const tab of tabs) {
      const tabId = tab.id;

      const frames = await browser.webNavigation.getAllFrames({tabId});
      for (const frame of frames) {
        const frameId = frame.frameId;

        if (frameId && recaptchaChallengeUrlRx.test(frame.url)) {
          await browser.tabs.insertCSS(tabId, {
            frameId,
            runAt: 'document_idle',
            file: '/src/solve/style.css'
          });

          await browser.tabs.executeScript(tabId, {
            frameId,
            runAt: 'document_idle',
            file: '/src/solve/script.js'
          });
        }
      }
    }

    const setupTabs = await browser.tabs.query({
      url: 'http://127.0.0.1/buster/setup?session=*',
      windowType: 'normal'
    });

    for (const tab of setupTabs) {
      await browser.tabs.reload(tab.id);
    }
  }
}

function addBrowserActionListener() {
  browser.browserAction.onClicked.addListener(onActionButtonClick);
}

function addMessageListener() {
  browser.runtime.onMessage.addListener(onMessage);
}

function addInstallListener() {
  browser.runtime.onInstalled.addListener(onInstall);
}

async function setup() {
  if (!(await isStorageReady())) {
    await migrateLegacyStorage();
    await initStorage();
  }

  await setChallengeLocale();
}

function init() {
  addBrowserActionListener();
  addMessageListener();
  addInstallListener();

  setup();
}

init();
