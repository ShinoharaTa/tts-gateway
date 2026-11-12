/**
 * 記号の読み替え（前処理）。表示用の文から読ませる文を作る純関数。
 *
 * - ZEN-TTS の前処理（NFKC、桁区切り削除、数字・英単語は読みのモデルが読む、絵文字削除）に任せられるものは任せ、
 *   ここでは「記号の意味を日本語にする」ものだけ直す
 * - 文の数を変えない（「。」「！」「？」と改行を足さない・消さない）。URL・メールアドレスは消す
 */
export const URL_RE = /https?:\/\/[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+/g;
export const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
/** 2026/10/27 */
const DATE_RE = /(\d{4})\/(\d{1,2})\/(\d{1,2})(?![\d/])/g;
/** 300tokens → 300トークン */
const TOKENS_RE = /(\d)\s?tokens?(?![A-Za-z])/gi;
/** 300トークン/s → 300トークン毎秒（数字・英字・カナ・単位の直後の /s） */
const PER_SECOND_RE = /(?<=[\p{L}\p{N}%])\s?\/s(?![A-Za-z])/gu;
/** $20/月 → 20ドル月あたり（年・日も同じ） */
const PER_UNIT_RE = /(?<=[\p{L}\p{N}%])\s?\/(月|年|日)(?![\p{N}])/gu;
/** GPT-5.5 → GPT 5.5（英字-数字の型番のハイフン） */
const MODEL_HYPHEN_RE = /(?<=[A-Za-z])-(?=\d)/g;
/** 100→200 → 100から200 */
const ARROW_NUM_RE = /(?<=\d)\s*[→⇒➡]\s*(?=\d)/g;
const ARROW_RE = /\s*[→⇒➡]\s*/g;
/** 10〜12月 → 10から12月（NFKC で ～ は ~ になる） */
const TILDE_NUM_RE = /(?<=\d)\s*[〜~]\s*(?=\d)/g;
/** ジェフ・ベゾス → ジェフベゾス。それ以外の「・」は読点 */
const KANA_DOT_RE = /(?<=[\p{Script=Katakana}ー])・(?=[\p{Script=Katakana}])/gu;
const DOT_RE = /・/g;
const PERCENT_RE = /(\d)\s*%/g;
/** $20 / $1.5億 → 20ドル / 1.5億ドル */
const DOLLAR_RE = /\$\s*(\d[\d,]*(?:\.\d+)?)(万|億|兆)?/g;
/** ¥1,000 → 1000円 */
const YEN_RE = /[¥￥]\s*(\d[\d,]*(?:\.\d+)?)(万|億|兆)?/g;

const dropCommas = (n: string): string => n.replace(/,/g, '');

/** 画面の文を読ませる文にする */
export const toSpoken = (display: string): string =>
  display
    .normalize('NFKC')
    .replace(URL_RE, '')
    .replace(EMAIL_RE, '')
    .replace(DATE_RE, '$1年$2月$3日')
    .replace(TOKENS_RE, '$1トークン')
    .replace(PER_SECOND_RE, '毎秒')
    .replace(PER_UNIT_RE, '$1あたり')
    .replace(MODEL_HYPHEN_RE, ' ')
    .replace(ARROW_NUM_RE, 'から')
    .replace(ARROW_RE, '、')
    .replace(TILDE_NUM_RE, 'から')
    .replace(KANA_DOT_RE, '')
    .replace(DOT_RE, '、')
    .replace(PERCENT_RE, '$1パーセント')
    .replace(DOLLAR_RE, (_, n: string, unit = '') => `${dropCommas(n)}${unit}ドル`)
    .replace(YEN_RE, (_, n: string, unit = '') => `${dropCommas(n)}${unit}円`)
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
