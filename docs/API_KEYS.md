# API keys

English · [简体中文](API_KEYS.zh-CN.md) · [繁體中文](API_KEYS.zh-TW.md)

**Every third-party key is optional.** Without any key, Address uses only official registers, open map data, and other sources that need no authorization. The keys below add data for specific countries, enable online translation, or show AMap on the web UI.

Add keys in the admin console under **Integrations → Map keys**. They are stored encrypted in the database and only masked values are shown.

## Overview

| Provider | Purpose | Location in the admin console |
|---|---|---|
| [AMap WebService](#amap-webservice) | China address sync | Map keys → AMap |
| [Baidu Maps](#baidu-maps) | China address sync | Map keys → Baidu Maps |
| [Tencent Location Service](#tencent-location-service) | China address sync | Map keys → Tencent Maps |
| [Google Geocoding](#google-geocoding) | Street and house-number enrichment for sparse countries | Map keys → Google Geocoding |
| [Geoapify](#geoapify) | South Korea addresses and postcodes | Map keys → Geoapify |
| [Mappls](#mappls) | India address enrichment | Map keys → Mappls |
| [OneMap](#onemap) | Singapore address sync | Map keys → OneMap |
| [DeepL API Free](#deepl-api-free) | Address translation | Online translation → DeepL |
| [Youdao Text Translation](#youdao-text-translation) | Address translation (paid) | Online translation → Youdao |
| [OpenAI-compatible API](#openai-compatible-api) | Translate addresses with any Chat Completions model | Online translation → OpenAI-compatible |
| [AMap JavaScript API](#amap-javascript-api) | Show AMap on the web UI | AMap frontend map credential |

**Multiple keys rotate automatically.** Add several keys for the same provider: a failing key cools down while the others take over, and when none is available the system waits for the earliest to recover. Each key can have its own quota limit.

## Maps and geocoding

### AMap WebService

1. In the [AMap console](https://console.amap.com/dev/index), create an application and a **Web Service** key following the [official guide](https://lbs.amap.com/api/webservice/create-project-and-key).
2. Restrict it to your server IP.
3. Add it under “AMap”.

### Baidu Maps

1. In the [Baidu Maps API console](https://lbsyun.baidu.com/apiconsole/key), create a **server-side** application with Place Search enabled.
2. Restrict it to your server IP.
3. Add the AK under “Baidu Maps”.

### Tencent Location Service

1. In the [Tencent Location Service console](https://lbs.qq.com/dev/console/application/mine), create an application with **WebServiceAPI** enabled.
2. Configure a server IP allowlist or signature verification.
3. Add it under “Tencent Maps”.

### Google Geocoding

1. Create a Google Cloud project with a billing account.
2. Enable the **Geocoding API** and create a key restricted to the Geocoding API and your server IP ([official guide](https://developers.google.com/maps/documentation/geocoding/get-api-key)).
3. Add it under “Google Geocoding”.

Address uses Geocoding API v4 and does not need the Places API. Google includes 10,000 free calls per billing account per month; Address uses at most 9,000 by default. If the same billing account is used elsewhere, enter that usage as “Usage already this month” in the key settings.

### Geoapify

Create a project in [Geoapify MyProjects](https://myprojects.geoapify.com/), copy the API key, and add it under “Geoapify”. See the [reverse geocoding docs](https://apidocs.geoapify.com/docs/geocoding/reverse-geocoding/).

### Mappls

Create an application in the [Mappls console](https://auth.mappls.com/console/), enable the **Reverse Geocoding API**, copy the static key, restrict it to your server IP, and add it under “Mappls”.

### OneMap

Register at [OneMap](https://www.onemap.gov.sg/apidocs/register), generate an access token with the [authentication API](https://www.onemap.gov.sg/apidocs/authentication), and add it under “OneMap”. Tokens expire after 3 days and must be replaced before then.

### AMap JavaScript API

Shows AMap on the web result page. It **cannot share** a key with AMap WebService:

1. Create a separate **Web (JS API)** key and security secret in the AMap console.
2. Restrict the key to your public domain.
3. Enter the key and secret under “AMap frontend map credential”.

The secret stays on the server and is used through the same-origin proxy `/_AMapService`; it never reaches the browser. Turn the map on or off under “Frontend map display” on the same page.

## Online translation

Translation runs in this order:

1. Existing valid translations and the cache.
2. Enabled online providers, **lowest priority number first**; providers with the same priority take turns.
3. Providers that are unavailable, cooling down, or out of quota are skipped.

Each translation key has its own priority in its edit dialog. Google web translation needs no key and has its priority next to its toggle; it is not the paid Cloud Translation API, may be rate-limited, and is not guaranteed to be available.

Translations must keep house numbers, unit numbers, and postcodes unchanged and pass language checks before they are cached or displayed.

### DeepL API Free

Add a free key ending in `:fx` under “DeepL” and set the project character limit (default 500,000). “Test” only checks the quota and uses no characters.

- Only `https://api-free.deepl.com` is allowed; Pro keys and endpoints are rejected.
- All DeepL keys share one character ledger; the usable amount is the smaller of the account quota and the project limit.
- DeepL usage may lag by a few minutes, and the Free API reports no billing period, so the local ledger never resets automatically.

### Youdao Text Translation

> **Paid service.** Youdao bills by usage. Once the trial credit is used up, both tests and automatic translation are charged. The quota set in Address is only an internal limit and does not mean you stay within any free tier. Do not add or enable it if you do not accept the cost.

Create an application with text translation enabled at [Youdao AI](https://ai.youdao.com/), then enter the app ID and app secret under “Youdao”. See the [official pricing](https://ai.youdao.com/DOCSIRMA/html/trans/price/plwbfy/index.html).

### OpenAI-compatible API

Connect any service that speaks the OpenAI **Chat Completions** format, such as DeepSeek, a Gemini proxy, or OpenRouter.

**Add a provider**

1. Click Add under “OpenAI-compatible” and enter the base URL and API key.
2. Click the button next to the model field to load the model list and pick one, or type the model name.
3. Save, then click “Test” to confirm it works.

Quota defaults to “Unlimited”; uncheck it and enter a daily request limit if you need one.

**Base URL**: a prefix or the full URL both work; the actual request URL is previewed below the field.

| You enter | Requests go to |
|---|---|
| `https://api.example.com/v1` | `https://api.example.com/v1/chat/completions` |
| `https://api.example.com/v1/chat/completions` | Used as-is |
| `https://api.example.com` (no version) | Detected on save, usually `…/v1/chat/completions` |

Remote URLs must use HTTPS; HTTP is allowed only for `localhost`.

**Prompt**: new providers are prefilled with the built-in default prompt; leaving it empty also uses the default, and edits can be reset in one click. The prompt only adjusts translation style; the rules for JSON-only output, matching item count, and preserved numbers are always appended and cannot be overridden.

**Reasoning effort**: `low` is sent by default. Reasoning models are slow, so each translation request (including queueing) may take up to 120 seconds. When the model list reports supported levels, a suitable one is chosen automatically; otherwise enter a value from the provider's docs.

**Test**: “Test” opens a log window that shows, step by step:

- The request URL, model, and parameters
- HTTP status and latency
- Finish reason, token usage, and the model's reply
- On failure, the provider's error message (with the API key masked)

There are two modes: a connectivity test that sends `"hi"`, and an address translation sample. Credentials marked “Needs review” can still be tested and return to service when a test passes; a malformed model reply never marks a credential for review.

## Security

- Restrict server-side keys to your server IP and web map keys to your domain.
- Never put keys in the repository, screenshots, or logs.
- Back up `data/secrets/config_master_key` together with the database; stored keys cannot be decrypted without it.
