import type { AdminLocale } from './types';

interface IndexTranslateText {
  title: string; keyless: string; toggle: string; notice: string; baseUrl: string; model: string; test: string; testSuccess: string; hint: string;
}

export const indexTranslateText: Record<AdminLocale, IndexTranslateText> = {
  'zh-CN': {
    title: 'Index-Translate（bilibili）', keyless: '无需密钥', toggle: '启用 Index-Translate',
    notice: 'bilibili 的翻译模型，通过免密钥公共接口调用，请求不传思考强度。地址组件会发送给 bilibili；官方未公布限额，建议并发从 1 开始。',
    baseUrl: '接口地址', model: '模型', test: '测试', testSuccess: 'Index-Translate 测试翻译成功',
    hint: '数字越小越先使用；失败或限速的路由会被跳过并冷却。'
  },
  'zh-TW': {
    title: 'Index-Translate（bilibili）', keyless: '無需金鑰', toggle: '啟用 Index-Translate',
    notice: 'bilibili 的翻譯模型，透過免金鑰公共介面呼叫，請求不傳思考強度。地址元件會傳送給 bilibili；官方未公布限額，建議並行數從 1 開始。',
    baseUrl: '介面位址', model: '模型', test: '測試', testSuccess: 'Index-Translate 測試翻譯成功',
    hint: '數字越小越先使用；失敗或限速的路由會被略過並冷卻。'
  },
  en: {
    title: 'Index-Translate (bilibili)', keyless: 'No key required', toggle: 'Enable Index-Translate',
    notice: 'bilibili\'s translation model behind a keyless public endpoint; requests send no reasoning setting. Address components are sent to bilibili, and rate limits are not published, so start with concurrency 1.',
    baseUrl: 'Endpoint', model: 'Model', test: 'Test', testSuccess: 'Index-Translate translated the test values',
    hint: 'Lower numbers run first; a failing or rate-limited route is skipped and cools down.'
  },
  ja: {
    title: 'Index-Translate（bilibili）', keyless: 'キー不要', toggle: 'Index-Translate を有効にする',
    notice: 'bilibili の翻訳モデルをキー不要の公開エンドポイントで呼び出します。推論強度は送信しません。住所の構成要素は bilibili に送信され、利用制限は公開されていないため、同時実行数は 1 から始めてください。',
    baseUrl: 'エンドポイント', model: 'モデル', test: 'テスト', testSuccess: 'Index-Translate でテスト翻訳に成功しました',
    hint: '数値が小さいほど優先されます。失敗またはレート制限されたルートはスキップされ、クールダウンします。'
  },
  ko: {
    title: 'Index-Translate (bilibili)', keyless: '키 불필요', toggle: 'Index-Translate 사용',
    notice: 'bilibili 번역 모델을 키가 필요 없는 공개 엔드포인트로 호출하며 추론 강도는 보내지 않습니다. 주소 구성 요소가 bilibili로 전송되고 사용 한도가 공개되지 않았으므로 동시 실행 수는 1부터 시작하세요.',
    baseUrl: '엔드포인트', model: '모델', test: '테스트', testSuccess: 'Index-Translate 테스트 번역에 성공했습니다',
    hint: '숫자가 작을수록 먼저 사용합니다. 실패하거나 속도 제한된 경로는 건너뛰고 대기합니다.'
  },
  de: {
    title: 'Index-Translate (bilibili)', keyless: 'Kein Schlüssel nötig', toggle: 'Index-Translate aktivieren',
    notice: 'Übersetzungsmodell von bilibili über einen öffentlichen Endpunkt ohne Schlüssel; es wird keine Reasoning-Einstellung gesendet. Adressbestandteile werden an bilibili gesendet, Limits sind nicht veröffentlicht – beginnen Sie mit Parallelität 1.',
    baseUrl: 'Endpunkt', model: 'Modell', test: 'Testen', testSuccess: 'Index-Translate hat die Testwerte übersetzt',
    hint: 'Kleinere Zahlen laufen zuerst; fehlerhafte oder gedrosselte Routen werden übersprungen und pausieren.'
  },
  fr: {
    title: 'Index-Translate (bilibili)', keyless: 'Aucune clé requise', toggle: 'Activer Index-Translate',
    notice: 'Modèle de traduction de bilibili via un point d’accès public sans clé ; aucun paramètre de raisonnement n’est envoyé. Les composants d’adresse sont envoyés à bilibili et les limites ne sont pas publiées : commencez avec une concurrence de 1.',
    baseUrl: 'Point d’accès', model: 'Modèle', test: 'Tester', testSuccess: 'Index-Translate a traduit les valeurs de test',
    hint: 'Les plus petits nombres passent en premier ; une route en échec ou limitée est ignorée puis mise en pause.'
  },
  es: {
    title: 'Index-Translate (bilibili)', keyless: 'Sin clave', toggle: 'Activar Index-Translate',
    notice: 'Modelo de traducción de bilibili mediante un endpoint público sin clave; no se envía ningún nivel de razonamiento. Los componentes de la dirección se envían a bilibili y los límites no están publicados: empiece con concurrencia 1.',
    baseUrl: 'Endpoint', model: 'Modelo', test: 'Probar', testSuccess: 'Index-Translate tradujo los valores de prueba',
    hint: 'Los números más bajos se usan primero; una ruta con fallos o limitada se omite y entra en espera.'
  },
  pt: {
    title: 'Index-Translate (bilibili)', keyless: 'Sem chave', toggle: 'Ativar Index-Translate',
    notice: 'Modelo de tradução da bilibili por um endpoint público sem chave; nenhum nível de raciocínio é enviado. Os componentes do endereço são enviados à bilibili e os limites não são publicados: comece com concorrência 1.',
    baseUrl: 'Endpoint', model: 'Modelo', test: 'Testar', testSuccess: 'O Index-Translate traduziu os valores de teste',
    hint: 'Números menores são usados primeiro; uma rota com falha ou limitada é ignorada e entra em espera.'
  }
};
