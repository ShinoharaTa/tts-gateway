/**
 * 記号の読み替え（前処理）。表示用の文から読ませる文を作る純関数。
 *
 * - ZEN-TTS の前処理（NFKC、桁区切り削除、数字・英単語は読みのモデルが読む、絵文字削除）に任せられるものは任せ、
 *   ここでは「記号の意味を日本語にする」ものだけ直す
 * - 文の数を変えない（「。」「！」「？」と改行を足さない・消さない）。URL・メールアドレスは消す
 * - 読み辞書（readings.ts）の前に走る段（beforeReadings: NFKC・URL とメールの削除・中黒）と、後に走る段
 *   （afterReadings: 日付・トークン・単位・型番・矢印・%・通貨）に分かれる。辞書の surface（GPT-4o、COVID-19）を
 *   記号の規則で崩す前に当て、辞書の読み（カタカナ・ー・・・空白）は後の段で変わらない
 * - 空白は改行をまたがない（[ \t]。NFKC 済みなので全角空白は半角になっている）
 */
/** ASCII の URL 文字だけ。末尾の . , ) ! ? は URL に含めない（「https://example.com/a!すごい?」の ! を残す） */
export const URL_RE = /https?:\/\/[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]*[A-Za-z0-9\-_~:/#[\]@$&'(*+;=%]/g;
export const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
/** 2026/10/27 */
const DATE_RE = /(\d{4})\/(\d{1,2})\/(\d{1,2})(?![\d/])/g;
/** 300tokens → 300トークン */
const TOKENS_RE = /(\d)[ \t]?tokens?(?![A-Za-z])/gi;
/** 300トークン/s → 300トークン毎秒（数字・英字・カナ・単位の直後の /s） */
const PER_SECOND_RE = /(?<=[\p{L}\p{N}%])[ \t]?\/s(?![A-Za-z])/gu;
/** $20/月 → 20ドル月あたり（年・日も同じ） */
const PER_UNIT_RE = /(?<=[\p{L}\p{N}%])[ \t]?\/(月|年|日)(?![\p{N}])/gu;
/** GPT-5.5 → GPT 5.5（英字-数字の型番のハイフン） */
const MODEL_HYPHEN_RE = /(?<=[A-Za-z])-(?=\d)/g;
/** 100→200 → 100から200 */
const ARROW_NUM_RE = /(?<=\d)[ \t]*[→⇒➡][ \t]*(?=\d)/g;
const ARROW_RE = /[ \t]*[→⇒➡][ \t]*/g;
/** 10〜12月 → 10から12月（NFKC で ～ は ~ になる） */
const TILDE_NUM_RE = /(?<=\d)[ \t]*[〜~][ \t]*(?=\d)/g;
/** ジェフ・ベゾス → ジェフベゾス。それ以外の「・」は読点 */
const KANA_DOT_RE = /(?<=[\p{Script=Katakana}ー])・(?=[\p{Script=Katakana}])/gu;
const DOT_RE = /・/g;
const PERCENT_RE = /(\d)[ \t]*%/g;
/** $20 / $1.5億 → 20ドル / 1.5億ドル */
const DOLLAR_RE = /\$[ \t]*(\d[\d,]*(?:\.\d+)?)(万|億|兆)?/g;
/** ¥1,000 → 1000円 */
const YEN_RE = /[¥￥][ \t]*(\d[\d,]*(?:\.\d+)?)(万|億|兆)?/g;

const dropCommas = (n: string): string => n.replace(/,/g, '');

/** 辞書の前の段。NFKC・URL とメールアドレスの削除・中黒 */
export const beforeReadings = (display: string): string =>
  display
    .normalize('NFKC')
    .replace(URL_RE, '')
    .replace(EMAIL_RE, '')
    .replace(KANA_DOT_RE, '')
    .replace(DOT_RE, '、');

/** 辞書の後の段。残りの記号の規則（辞書の読みのカタカナ・ー・・・空白には当たらない） */
export const afterReadings = (text: string): string =>
  text
    .replace(DATE_RE, '$1年$2月$3日')
    .replace(TOKENS_RE, '$1トークン')
    .replace(PER_SECOND_RE, '毎秒')
    .replace(PER_UNIT_RE, '$1あたり')
    .replace(MODEL_HYPHEN_RE, ' ')
    .replace(ARROW_NUM_RE, 'から')
    .replace(ARROW_RE, '、')
    .replace(TILDE_NUM_RE, 'から')
    .replace(PERCENT_RE, '$1パーセント')
    .replace(DOLLAR_RE, (_, n: string, unit = '') => `${dropCommas(n)}${unit}ドル`)
    .replace(YEN_RE, (_, n: string, unit = '') => `${dropCommas(n)}${unit}円`)
    .replace(/[ \t]{2,}/g, ' ')
    .trim();

/** 画面の文を読ませる文にする（辞書を通さない場合。beforeReadings → afterReadings） */
export const toSpoken = (display: string): string => afterReadings(beforeReadings(display));
