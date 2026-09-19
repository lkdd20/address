# API key configuration

[English](API_KEYS.md) · [简体中文](API_KEYS.zh-CN.md) · [繁體中文](API_KEYS.zh-TW.md)

Add credentials in **Admin → Service credentials**. Multiple credentials under the same provider are rotated automatically.

| Provider | Country or feature | Administrator entry |
|---|---|---|
| AMap WebService | China address synchronization | AMap |
| Baidu Maps | China address synchronization | Baidu Maps |
| Tencent Location Service | China address synchronization | Tencent Maps |
| Mappls Reverse Geocoding | India address enrichment | Mappls |
| OneMap | Singapore address synchronization | OneMap |
| Geoapify Reverse Geocoding | South Korea address and postcode enrichment | Geoapify |
| Google Geocoding | Real street and premise enrichment for supported low-volume countries | Google Geocoding |
| Youdao Text Translation | Address translation | Youdao Translate |
| DeepL API Free | Address translation with configurable route priority | DeepL Free |
| OpenAI-compatible Chat Completions | Address translation with a configurable model | OpenAI-compatible |
| AMap JavaScript API | China browser map | AMap browser map |

## AMap WebService

1. Open the [AMap developer console](https://console.amap.com/dev/index).
2. Create an application and a **WebService** key using the [official guide](https://lbs.amap.com/api/webservice/create-project-and-key).
3. Apply the server IP restriction and add the key under **AMap**.

## Baidu Maps

1. Open the [Baidu Maps API console](https://lbsyun.baidu.com/apiconsole/key).
2. Create a **Server** application and enable the Place Web API.
3. Apply the server IP restriction and add the AK under **Baidu Maps**.

## Tencent Location Service

1. Open the [Tencent Location Service console](https://lbs.qq.com/dev/console/application/mine).
2. Create an application and enable **WebService API**.
3. Apply the server IP or signature restriction and add the key under **Tencent Maps**.

## Mappls Reverse Geocoding

1. Create an application in the [Mappls Console](https://auth.mappls.com/console/).
2. Enable **Reverse Geocoding API** and copy the static key from the credentials section.
3. Apply the server IP restriction and add the key under **Mappls**.

The integration follows the [Mappls Reverse Geocoding API](https://developer.mappls.com/documentation/sdk/rest-apis/mappls-maps-reverse-geocoding-rest-api-example/Readme/).

## OneMap

1. Register for [OneMap API access](https://www.onemap.gov.sg/apidocs/register).
2. Generate an access token through the [authentication API](https://www.onemap.gov.sg/apidocs/authentication).
3. Add the token under **OneMap**. Replace it before its three-day expiry.

## Geoapify

1. Create a project in [Geoapify MyProjects](https://myprojects.geoapify.com/).
2. Copy the project API key.
3. Add the key under **Geoapify**.

See the [Reverse Geocoding API documentation](https://apidocs.geoapify.com/docs/geocoding/reverse-geocoding/).

## Google Geocoding

1. Create or select a Google Cloud project and attach a billing account.
2. Enable **Geocoding API** using the [official setup guide](https://developers.google.com/maps/documentation/geocoding/get-api-key).
3. Create a server API key, restrict it to Geocoding API and the deployment server IP, then add it under **Google Geocoding**.

The project uses Geocoding API v4. Places API is not required.

## DeepL API Free

Add a Free key ending in `:fx` under **Online translation → DeepL Free**, set a project character cap, then use **Test** to retrieve usage without translating. The default cap is 500,000; it is configurable, but the verified account limit always applies. Only `https://api-free.deepl.com` is allowed; Pro keys and paid endpoints are rejected.

All API and synchronization calls share an encrypted credential broker and a persistent Unicode-character ledger. Effective allowance is the lowest account/configured cap across enabled DeepL keys. Characters are reserved before translation; lost responses retain the reservation. Restarts, key replacement and local calendar changes do not reset usage. Usage plus translation count as two upstream requests and both obey QPS limits.

[Provider usage](https://developers.deepl.com/docs/admin/retrieving-usage-data) can lag several minutes; [Free usage responses](https://developers.deepl.com/api-reference/usage-and-quota/check-usage-and-limits) may omit billing-period dates. Without a verified new period, the local ledger is not automatically reset, so fallback may occur early. Other applications using the same account are outside this project's control; the Free endpoint's official limit remains the final safeguard. Never clear the ledger to bypass a wait.

## Youdao Text Translation

**Paid service:** Youdao bills by usage. Trial credits may be limited; tests and automatic translation can charge your balance after those credits run out. Project quotas and the backfill character budget are internal limits, not a guarantee of free vendor usage. Check [Youdao pricing](https://ai.youdao.com/DOCSIRMA/html/trans/price/plwbfy/index.html) and your account before enabling it. Leave credentials unconfigured or disabled if you do not accept charges.

1. Register at [Youdao Zhiyun](https://ai.youdao.com/).
2. Create an application and enable Text Translation.
3. Add the application ID and application secret under **Online translation**.

Each entry stores one ID/secret pair; multiple pairs are supported.

Translation checks valid stored variants/cache first, then tries enabled online routes by ascending priority. Equal-priority routes use round-robin; unavailable, cooling-down, quota-exhausted, or failed routes are skipped. New OpenAI-compatible routes default ahead of DeepL, Youdao, and enabled keyless Google web translation, but administrators set priority in each API key’s editor. DeepL and Youdao keys are independent, just like OpenAI-compatible keys; Google web translation has no API key and keeps its priority beside its enable switch. The separate routing panel is removed. Existing provider priorities seed new per-key routes once. Google is not the billed Cloud Translation API and may rate-limit or be unavailable; unlimited or permanent free access is not guaranteed. Leave paid providers unconfigured or disabled if you do not accept their fees.

## OpenAI-compatible Chat Completions

Under **Online translation**, enter the endpoint and API key, fetch the live model list, then select a Chat Completions-compatible model. There is no hardcoded default model. A full `/chat/completions` or `/models` URL is accepted; custom API path prefixes are preserved. Base URLs include the provider API prefix (such as `/v1`); successful model discovery fills in the resolved prefix. Use the fetch button beside the model input to populate suggestions, or type a model ID directly. Advertised endpoint restrictions and reasoning levels are retained; all returned models remain visible in the full dropdown, with incompatible models marked and disabled. Opening the dropdown shows every model regardless of the saved value; typing filters the list. When reasoning metadata is absent, the interface says so and accepts a provider-documented value. The project explicitly sends `low` by default; legacy `default` settings are normalized to `low`. Other explicit values are sent unchanged. On model selection, advertised levels take precedence if they exclude `low`. This does not imply that the provider defaults to `low` when the parameter is omitted. The fixed prompt enforces JSON cardinality and preserves address identifiers; optional prompts add style only. The default project limit is 1,000 requests per day with one request per second; deployment settings can adjust these limits.

The service sends a non-streaming Chat Completions request with a translation-only system prompt and strict JSON cardinality. Values are treated as untrusted address data, not instructions. The returned values must preserve digits and identifiers and pass the existing language and publication gates before caching or publishing. The API key is encrypted in the control database and is never returned by ordinary provider listings. Use **Test** for a small synthetic request; it reports only success and result count.

Only HTTPS endpoints are accepted for remote services; plain HTTP is limited to localhost. Confirm the endpoint provider's terms, data handling, and model billing before enabling it.

## AMap JavaScript API

1. Create a separate **JavaScript API** key and security code in the AMap console.
2. Restrict the key to the production domain.
3. Add both values under **AMap browser map**.

Do not reuse the AMap WebService key for browser maps.

Initial online imports use the same per-key priority rules and broker accounting as recovery. Cached display translations are invalidated when source components change. Model discovery respects Retry-After in seconds or HTTP-date format. Do not assume trial or new-user credits renew; one-time DeepL rewards are not replenished locally.
