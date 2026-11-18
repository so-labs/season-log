import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  applyEdits, decodeTextBuffer, findSimilarTitles, formatX10, hasUnread, isCaughtUp,
  applyCheck, isFinishedReading,
  parseNewCsv, parseX10, stepProgress, stepValueX10, todayLocal, unreadX10,
  worksFromJson, worksToCsv, worksToJson,
  type Work,
} from './core';
import {
  applyImport, clearAllData, loadOrderedWorks, planImport, removeWork, restoreWork,
  saveNewWork, updateWork, type ImportPlan,
} from './db';
import {
  clearCloudSyncState, formatCloudDateTime,
  getActiveCloudProviderId, getCloudLastSyncedAt, getCloudRemoteUpdatedAt,
  setActiveCloudProviderId, setCloudLastSyncedAt, setCloudRemoteUpdatedAt,
  type CloudProvider, type CloudRemoteMeta,
} from './cloud';
import { googleDriveProvider } from './cloud-google-drive';
import { cancelHandover, issueHandover, redeemHandover, type IssuedHandover } from './handover';
import qrcode from 'qrcode-generator';

// 利用できるクラウド同期先の一覧。同期を有効にできるのは常に1つだけ。
// 別のクラウドを足すときは、ここに実装を追加する。
const CLOUD_PROVIDERS: CloudProvider[] = [googleDriveProvider];

const CATEGORIES = ['アニメ', '漫画', '映画', 'ドラマ', '小説', '書籍', 'ゲーム', '音楽', 'その他'];
const UNITS = ['話', '巻', '冊', '章', 'ページ', '本', '曲', '期', 'ステージ', '時間', '分', '%', 'その他'];
const PREVIEW_ROWS = 100;

interface Loaded {
  works: Work[];
  sourceName: string;
  format: 'new' | 'json';
}

interface Toast {
  message: string;
  work: Work; // 操作前の状態（元に戻す用）
  index: number;
  deleted: false | boolean;
}

function download(filename: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function statsOf(w: Work[]) {
  const c = (pred: (x: Work) => boolean) => w.filter(pred).length;
  return {
    total: w.length,
    favorite: c(x => x.favorite),
    completed: c(x => x.isCompleted),
    hidden: c(x => x.isHidden),
    adult: c(x => x.hasAdult),
    withDate: c(x => x.lastCheckedDate !== null),
    decimal: c(x => (x.progressX10 ?? 0) % 10 !== 0 || (x.maxX10 ?? 0) % 10 !== 0),
  };
}

// ---------- 作品カード（一覧の項目） ----------

interface WorkCardProps {
  work: Work;
  onStep: (w: Work, deltaX10: number) => void;
  onCheck: (w: Work) => void;
  onEdit: (w: Work) => void;
  onDelete: (w: Work) => void;
}

function WorkCard({ work: w, onStep, onCheck, onEdit, onDelete }: WorkCardProps) {
  const remain = unreadX10(w);
  const pct = w.maxX10 !== null && w.maxX10 > 0
    ? Math.min(100, Math.round(((w.progressX10 ?? 0) / w.maxX10) * 100))
    : null;
  return (
    <article className={`workCard${w.isHidden ? ' isHidden' : ''}`}>
      <div className="cardHead">
        <h3 className="cardTitle">{w.title}</h3>
        {w.favorite && <span className="star" aria-label="お気に入り">★</span>}
      </div>
      <div className="chipRow">
        <span className="chip">{w.category}</span>
        {w.isCompleted && <span className="badge badgeDone">完結</span>}
        {w.hasAdult && <span className="badge badgeAdult">アダルト</span>}
        {w.isHidden && <span className="badge badgeHidden">非表示</span>}
      </div>
      <div className="progressLine">
        <span className="progressNow">{formatX10(w.progressX10)}</span>
        <span className="progressSep">/</span>
        <span className="progressMax">{w.maxX10 === null ? '—' : formatX10(w.maxX10)}</span>
        <span className="unitLabel">{w.unit}</span>
        {remain !== null && remain > 0 && <span className="remain">残り {formatX10(remain)}</span>}
        {remain === 0 && w.maxX10 !== null && <span className="remain caughtUp">最新まで追いつき</span>}
      </div>
      {pct !== null && (
        <div className="progressBar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
          <div className="progressFill" style={{ width: `${pct}%` }} />
        </div>
      )}
      <div className="stepper">
        <button onClick={() => onStep(w, -10)} aria-label="進捗を1減らす">−1</button>
        <button onClick={() => onStep(w, -1)} aria-label="進捗を0.1減らす">−0.1</button>
        <button onClick={() => onStep(w, 1)} aria-label="進捗を0.1増やす">+0.1</button>
        <button onClick={() => onStep(w, 10)} aria-label="進捗を1増やす">+1</button>
      </div>
      {w.memo && <p className="memo">{w.memo}</p>}
      <div className="cardFoot">
        <span className="dates">
          <span>チェック {w.lastCheckedDate ?? '—'}</span>
          <span>進捗 {w.lastProgressDate ?? '—'}</span>
        </span>
        <span className="cardActions">
          <button className="ghostBtn" onClick={() => onCheck(w)}>確認</button>
          <button className="ghostBtn" onClick={() => onEdit(w)}>編集</button>
          <button className="ghostBtn danger" onClick={() => onDelete(w)}>削除</button>
        </span>
      </div>
    </article>
  );
}

// ---------- 汎用モーダル ----------
// すべてのダイアログはこの外枠を共有する: 背景クリックか Esc で閉じ、
// ダイアログが重なっているときは最前面のものだけが Esc に応じる
// （例: 設定ダイアログの上に重なる削除確認）。
// 開いている間は背後のページのスクロールを止める（最初の1つが開いた
// 時点で止め、すべて閉じた時点で元の状態に戻す）。

const modalStack: object[] = [];
let savedBodyOverflow: string | null = null;

function Modal({ title, onClose, wide, children }: {
  title: string;
  onClose: () => void;
  wide?: boolean;
  children: ReactNode;
}) {
  const idRef = useRef<object | null>(null);
  if (idRef.current === null) idRef.current = {};
  useEffect(() => {
    const id = idRef.current!;
    modalStack.push(id);
    if (modalStack.length === 1) {
      savedBodyOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && modalStack[modalStack.length - 1] === id) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      const i = modalStack.indexOf(id);
      if (i >= 0) modalStack.splice(i, 1);
      if (modalStack.length === 0) {
        document.body.style.overflow = savedBodyOverflow ?? '';
        savedBodyOverflow = null;
      }
    };
  }, [onClose]);
  return (
    <div className="modalOverlay" onClick={onClose}>
      <div className={`modal${wide ? ' settingsModal' : ''}`} role="dialog" aria-modal="true" aria-label={title} onClick={e => e.stopPropagation()}>
        <div className="modalHead">
          <h3 className="modalTitle">{title}</h3>
          <button className="modalClose" onClick={onClose} aria-label="閉じる">✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

function ConfirmDialog({ title, message, confirmLabel, onConfirm, onCancel }: {
  title: string;
  message: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal title={title} onClose={onCancel}>
      <p className="confirmMessage">{message}</p>
      <div className="modalActions">
        <button className="btn" onClick={onCancel}>キャンセル</button>
        <button className="btn btnDanger" onClick={onConfirm}>{confirmLabel}</button>
      </div>
    </Modal>
  );
}

// ---------- 編集フォーム（モーダル） ----------

interface EditFormProps {
  initial: Work;
  isNew: boolean;
  existingWorks: Work[];
  onSave: (draft: Work) => void;
  onCancel: () => void;
}

function EditForm({ initial, isNew, existingWorks, onSave, onCancel }: EditFormProps) {
  const [title, setTitle] = useState(initial.title);
  const [category, setCategory] = useState(initial.category);
  const [unit, setUnit] = useState(initial.unit);
  const [progressText, setProgressText] = useState(formatX10(initial.progressX10));
  const [maxText, setMaxText] = useState(formatX10(initial.maxX10));
  const [favorite, setFavorite] = useState(initial.favorite);
  const [isCompleted, setIsCompleted] = useState(initial.isCompleted);
  const [hasAdult, setHasAdult] = useState(initial.hasAdult);
  const [isHidden, setIsHidden] = useState(initial.isHidden);
  const [checkedDate, setCheckedDate] = useState(initial.lastCheckedDate ?? '');
  const [progressDate, setProgressDate] = useState(initial.lastProgressDate ?? '');
  const [memo, setMemo] = useState(initial.memo);
  const [formError, setFormError] = useState<string | null>(null);
  // 新規登録のときだけ、似たタイトルの既存作品を知らせる（登録自体は妨げない）。
  const similar = useMemo(
    () => (isNew ? findSimilarTitles(existingWorks, title) : []),
    [isNew, existingWorks, title],
  );

  function submit() {
    if (title.trim() === '') { setFormError('タイトルを入力してください'); return; }
    try {
      onSave({
        id: initial.id,
        title,
        category, unit,
        progressX10: parseX10(progressText) ?? 0,
        maxX10: parseX10(maxText), // 空欄は未確認（null）
        favorite, isCompleted, hasAdult, isHidden,
        lastCheckedDate: checkedDate === '' ? null : checkedDate,
        lastProgressDate: progressDate === '' ? null : progressDate,
        memo,
      });
    } catch (e) {
      setFormError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <Modal title={isNew ? '新規登録' : '編集'} onClose={onCancel}>
      <div className="formGrid">
        <label className="wide">タイトル <input type="text" value={title} onChange={e => setTitle(e.target.value)} /></label>
        {similar.length > 0 && (
          <p className="note wide">似たタイトルが登録済みです: {similar.map(w => `「${w.title}」（${w.category}）`).join('、')}。別の作品であれば、そのまま登録できます。</p>
        )}
        <label>カテゴリ
          <select value={category} onChange={e => setCategory(e.target.value)}>
            {!CATEGORIES.includes(category) && <option>{category}</option>}
            {CATEGORIES.map(c => <option key={c}>{c}</option>)}
          </select>
        </label>
        <label>進捗単位
          <select value={unit} onChange={e => setUnit(e.target.value)}>
            {!UNITS.includes(unit) && <option>{unit}</option>}
            {UNITS.map(u => <option key={u}>{u}</option>)}
          </select>
        </label>
        <label>進捗 <input type="text" inputMode="decimal" value={progressText} onChange={e => setProgressText(e.target.value)} placeholder="例: 11.1" /></label>
        <label>最大 <input type="text" inputMode="decimal" value={maxText} onChange={e => setMaxText(e.target.value)} placeholder="空欄 = 未確認" /></label>
        <label>最終チェック日 <input type="date" value={checkedDate} onChange={e => setCheckedDate(e.target.value)} /></label>
        <label>最終進捗日 <input type="date" value={progressDate} onChange={e => setProgressDate(e.target.value)} /></label>
        <label className="wide">メモ <input type="text" value={memo} onChange={e => setMemo(e.target.value)} /></label>
      </div>
      <div className="flagRow">
        <label><input type="checkbox" checked={favorite} onChange={e => setFavorite(e.target.checked)} /> お気に入り</label>
        <label><input type="checkbox" checked={isCompleted} onChange={e => setIsCompleted(e.target.checked)} /> 完結</label>
        <label><input type="checkbox" checked={hasAdult} onChange={e => setHasAdult(e.target.checked)} /> アダルト</label>
        <label><input type="checkbox" checked={isHidden} onChange={e => setIsHidden(e.target.checked)} /> 非表示</label>
      </div>
      <p className="note">進捗を変えると最終進捗日、最大を変えると最終チェック日が自動で今日になります（日付を自分で変えた場合はそちら優先）。</p>
      {formError && <p className="error" role="alert">{formError}</p>}
      <div className="modalActions">
        <button className="btn" onClick={onCancel}>キャンセル</button>
        <button className="btn btnPrimary" onClick={submit}>保存する</button>
      </div>
    </Modal>
  );
}

// ---------- メイン画面 ----------

// ---------- 確認ダイアログ ----------

function CheckDialog({ work, onConfirm, onCancel }: {
  work: Work;
  onConfirm: (maxX10: number | null) => void;
  onCancel: () => void;
}) {
  const [maxX10, setMaxX10] = useState<number | null>(work.maxX10);
  // 最新話の更新を外部で調べる用に、タイトルをそのままコピーできるようにする。
  const [copyState, setCopyState] = useState<'idle' | 'done' | 'error'>('idle');
  async function copyTitle() {
    try {
      await navigator.clipboard.writeText(work.title);
      setCopyState('done');
    } catch {
      setCopyState('error');
    }
    window.setTimeout(() => setCopyState('idle'), 2000);
  }
  const step = (deltaX10: number) => {
    if (maxX10 === null) {
      // 未確認からの増分は0起点にする（減らす操作は受け付けない）。
      if (deltaX10 > 0) setMaxX10(deltaX10);
      return;
    }
    setMaxX10(stepValueX10(maxX10, deltaX10));
  };
  return (
    <Modal title="確認" onClose={onCancel}>
      <p className="checkTarget">「{work.title}」の最終チェック日を今日で記録します。</p>
      <div className="checkMaxRow">
        <p className="checkMaxLine">最大: {maxX10 === null ? '未確認' : `${formatX10(maxX10)} ${work.unit}`}</p>
        <button type="button" className="ghostBtn" onClick={() => void copyTitle()}>{copyState === 'done' ? 'コピーしました' : copyState === 'error' ? 'コピーできませんでした' : 'タイトルをコピー'}</button>
      </div>
      <div className="stepper">
        <button onClick={() => step(-10)} disabled={maxX10 === null} aria-label="最大を1減らす">−1</button>
        <button onClick={() => step(-1)} disabled={maxX10 === null} aria-label="最大を0.1減らす">−0.1</button>
        <button onClick={() => step(1)} aria-label="最大を0.1増やす">+0.1</button>
        <button onClick={() => step(10)} aria-label="最大を1増やす">+1</button>
      </div>
      <p className="note">新しい分が出ていたら、最大を増やしてからOKしてください。何も変えずにOKすると、最終チェック日だけが今日になります。</p>
      <div className="modalActions">
        <button className="btn" onClick={onCancel}>キャンセル</button>
        <button className="btn btnPrimary" onClick={() => onConfirm(maxX10)}>OK</button>
      </div>
    </Modal>
  );
}

/** 並び順の選択肢（値と表示名）。端末に記憶した値の検証にも使う。 */
const SORT_OPTIONS = [
  { value: 'orderDesc', label: '保存順（新しい順）' },
  { value: 'orderAsc', label: '保存順（古い順）' },
  { value: 'titleAsc', label: 'タイトル順' },
  { value: 'titleDesc', label: 'タイトル逆順' },
  { value: 'unreadDesc', label: '残りが多い順' },
  { value: 'unreadAsc', label: '残りが少ない順' },
  { value: 'progressDesc', label: '最終進捗日が新しい順' },
  { value: 'progressAsc', label: '最終進捗日が古い順' },
  { value: 'checkAsc', label: '最終チェック日が古い順' },
  { value: 'checkDesc', label: '最終チェック日が新しい順' },
] as const;

/** 「表示」の選択肢の値。端末に記憶した条件の検証にも使う。 */
const VIEW_KEYS = ['all', 'check', 'unread', 'caughtup', 'finished', 'notfinished'];

const FLAG_MODES = ['any', 'only', 'exclude'];

interface SavedFilters {
  viewKey: string;
  categoryFilter: string;
  flagFilters: Record<'favorite' | 'completed' | 'adult' | 'hidden', 'any' | 'only' | 'exclude'>;
}

/** 端末に記憶した絞り込み条件（表示・カテゴリ・フラグ）を読む。壊れた値や想定外の値は既定に落とす。 */
function loadSavedFilters(): SavedFilters {
  const defaults: SavedFilters = {
    viewKey: 'all',
    categoryFilter: 'all',
    flagFilters: {
      favorite: 'any',
      completed: 'any',
      adult: 'any',
      hidden: 'exclude',
    },
  };
  try {
    const raw = localStorage.getItem('season-log:filters');
    if (raw === null) return defaults;
    const parsed = JSON.parse(raw) as Partial<SavedFilters>;
    const flags = (parsed.flagFilters ?? {}) as Record<string, unknown>;
    const flagOr = (key: keyof SavedFilters['flagFilters']) =>
      typeof flags[key] === 'string' && FLAG_MODES.includes(flags[key] as string)
        ? (flags[key] as SavedFilters['flagFilters'][typeof key])
        : defaults.flagFilters[key];
    return {
      viewKey: typeof parsed.viewKey === 'string' && VIEW_KEYS.includes(parsed.viewKey) ? parsed.viewKey : defaults.viewKey,
      categoryFilter: typeof parsed.categoryFilter === 'string' ? parsed.categoryFilter : defaults.categoryFilter,
      flagFilters: {
        favorite: flagOr('favorite'),
        completed: flagOr('completed'),
        adult: flagOr('adult'),
        hidden: flagOr('hidden'),
      },
    };
  } catch {
    return defaults;
  }
}

export default function App() {
  // 設定は localStorage に置く（端末ローカル。作品データには混ぜない）。
  const [category, setCategory] = useState(() => localStorage.getItem('season-log:defaultCategory') ?? '漫画');
  const [unit, setUnit] = useState(() => localStorage.getItem('season-log:defaultUnit') ?? '話');
  useEffect(() => { localStorage.setItem('season-log:defaultCategory', category); }, [category]);
  useEffect(() => { localStorage.setItem('season-log:defaultUnit', unit); }, [unit]);

  const stored = useLiveQuery(() => loadOrderedWorks(), [], [] as Work[]);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savedNote, setSavedNote] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [settingsTab, setSettingsTab] = useState<'general' | 'data' | 'cloud'>('general');
  const [showSearch, setShowSearch] = useState(false);
  const [confirmingClear, setConfirmingClear] = useState(false);
  // 作品の削除は誤タップ対策として、実行前に汎用モーダルで確認する。
  const [confirmingDelete, setConfirmingDelete] = useState<Work | null>(null);
  const [query, setQuery] = useState('');
  type FlagMode = 'any' | 'only' | 'exclude';
  // 絞り込み条件（表示・カテゴリ・フラグ）は、並び順と同じく端末にだけ記憶する
  // （作品データや書き出しには含めない）。検索語は記憶しない（開き直したときに
  // 前回の検索語で絞られたままになると、かえって分かりにくいため）。
  const [savedFilters] = useState(loadSavedFilters);
  const [flagFilters, setFlagFilters] = useState<Record<'favorite' | 'completed' | 'adult' | 'hidden', FlagMode>>(savedFilters.flagFilters);
  const [viewKey, setViewKey] = useState(savedFilters.viewKey);
  const [categoryFilter, setCategoryFilter] = useState(savedFilters.categoryFilter);
  // 並び順は端末にだけ記憶する（作品データや書き出しには含めない）。
  const [sortKey, setSortKey] = useState(() => {
    const v = localStorage.getItem('season-log:sort');
    return v !== null && SORT_OPTIONS.some(o => o.value === v) ? v : 'orderDesc';
  });
  useEffect(() => { localStorage.setItem('season-log:sort', sortKey); }, [sortKey]);
  useEffect(() => {
    localStorage.setItem('season-log:filters', JSON.stringify({
      viewKey,
      categoryFilter,
      flagFilters,
    }));
  }, [viewKey, categoryFilter, flagFilters]);
  // 並び順・絞り込みの下書き: パネルやモーダルで編集しても、「適用」を押すまでは
  // 一覧（適用済みの条件）に反映しない。開くたびに適用済みの条件から作り直す。
  // PCの一覧上の検索ボックスだけは適用済みを直接編集する（即時反映）。
  const [draftQuery, setDraftQuery] = useState('');
  const [draftViewKey, setDraftViewKey] = useState('all');
  const [draftCategoryFilter, setDraftCategoryFilter] = useState('all');
  const [draftSortKey, setDraftSortKey] = useState('orderDesc');
  const [draftFlagFilters, setDraftFlagFilters] = useState<Record<'favorite' | 'completed' | 'adult' | 'hidden', FlagMode>>({
    favorite: 'any', completed: 'any', adult: 'any', hidden: 'exclude',
  });
  // PCの並び順・絞り込みアコーディオンの開閉。
  const [showFilterPanel, setShowFilterPanel] = useState(false);
  type ThemePref = 'light' | 'system' | 'dark';
  const [themePref, setThemePref] = useState<ThemePref>(() => {
    const v = localStorage.getItem('season-log:theme');
    // 'auto' はテーマ導入初版で使った値で、'system' と同じ意味として読み替える。
    return v === 'light' || v === 'dark' ? v : 'system';
  });
  useEffect(() => {
    localStorage.setItem('season-log:theme', themePref);
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const effective =
        themePref === 'system' ? (mq.matches ? 'dark' : 'light') : themePref;
      document.documentElement.dataset.theme = effective;
      // ステータスバーの色（theme-color）も、実効テーマの背景色に合わせる。
      document
        .querySelector('meta[name="theme-color"]')
        ?.setAttribute('content', effective === 'dark' ? '#0F1F1E' : '#FAFAF9');
    };
    apply();
    if (themePref !== 'system') return;
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [themePref]);
  const [editing, setEditing] = useState<{ mode: 'new' } | { mode: 'edit'; original: Work } | null>(null);
  const [checking, setChecking] = useState<Work | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  // クラウド同期（手動のみ）: 有効なプロバイダは常に1つだけ。
  const [cloudProviderId, setCloudProviderId] = useState(() => getActiveCloudProviderId());
  const [cloudConnected, setCloudConnected] = useState(false);
  const [cloudBusy, setCloudBusy] = useState<string | null>(null);
  const [cloudError, setCloudError] = useState<string | null>(null);
  const [cloudNote, setCloudNote] = useState<string | null>(null);
  const [cloudLastSynced, setCloudLastSynced] = useState(() => getCloudLastSyncedAt());
  const [cloudRemoteMeta, setCloudRemoteMeta] = useState<CloudRemoteMeta | null>(null);
  const [confirmingCloudOverwrite, setConfirmingCloudOverwrite] = useState(false);
  // クラウドから読み込んだ取り込み待ちデータの出所（保存時に同期記録を更新するため）。
  const [loadedFromCloud, setLoadedFromCloud] = useState<CloudRemoteMeta | null>(null);
  const activeCloudProvider = CLOUD_PROVIDERS.find(p => p.id === cloudProviderId) ?? null;
  // 引き継ぎコード（実験的）: 発行したコードとQR、受け取り入力欄の状態。
  const [handoverBusy, setHandoverBusy] = useState<string | null>(null);
  const [handoverError, setHandoverError] = useState<string | null>(null);
  const [handoverNote, setHandoverNote] = useState<string | null>(null);
  const [issuedHandover, setIssuedHandover] = useState<(IssuedHandover & { qrSvg: string }) | null>(null);
  const [redeemCode, setRedeemCode] = useState('');
  const [handoverNow, setHandoverNow] = useState(() => Date.now());
  const handoverNoteTimer = useRef<number | null>(null);

  // 完了報告の案内文（取り消し・コピーなど）は、一定時間で自動的に消す。
  // 「取り込み待ち」のような次の操作を促す案内文は対象にしない。
  // タイマーが発火した時点で別の案内文に差し替わっていたら、そちらは消さない。
  function showTransientHandoverNote(text: string) {
    setHandoverNote(text);
    if (handoverNoteTimer.current !== null) window.clearTimeout(handoverNoteTimer.current);
    handoverNoteTimer.current = window.setTimeout(() => {
      setHandoverNote(current => (current === text ? null : current));
    }, 8000);
  }

  // 端末の空き容量が逼迫したときに、ブラウザがこのサイトの保存領域
  // （作品データや条件の記憶）を自動で消してしまわないよう、永続化を要求する。
  useEffect(() => {
    if (navigator.storage?.persist) void navigator.storage.persist();
  }, []);

  // QRコード（コード入りのURL）をスマホのカメラで読み取って開いた場合:
  // コードを受け取り欄に入れた状態で設定のデータ管理を開く。
  // コード自体は「受け取る」を押すまで使われない。URLの # は履歴に
  // 残らないよう、読み取ったら取り除く。
  useEffect(() => {
    const m = window.location.hash.match(/handover=([0-9A-Za-z]{10})/);
    if (!m) return;
    setRedeemCode(m[1].toUpperCase());
    setSettingsTab('data');
    setShowSettings(true);
    setHandoverNote('引き継ぎコードが入力されています。「受け取る」を押してください。');
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }, []);

  // 発行したコードの残り時間を数える（期限が来たら表示を消す）。
  useEffect(() => {
    if (!issuedHandover) return;
    const t = setInterval(() => setHandoverNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [issuedHandover]);

  useEffect(() => {
    if (!issuedHandover) return;
    if (handoverNow < new Date(issuedHandover.expiresAt).getTime()) return;
    setIssuedHandover(null);
    showTransientHandoverNote('引き継ぎコードの有効期限が切れました。必要な場合は発行し直してください。');
  }, [issuedHandover, handoverNow]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 8000);
    return () => clearTimeout(t);
  }, [toast]);

  // 「先頭へ戻る」ボタンの表示: 一定量スクロールしたら出す
  const [showToTop, setShowToTop] = useState(false);
  useEffect(() => {
    const onScroll = () => setShowToTop(window.scrollY > 600);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  // バージョン表示: sw.js の CACHE_NAME（season-log-YYYY.MM-rN）から取り出す
  const [appVersion, setAppVersion] = useState('');
  useEffect(() => {
    let cancelled = false;
    fetch('/sw.js', { cache: 'no-store' })
      .then(res => (res.ok ? res.text() : ''))
      .then(text => {
        const m = text.match(/season-log-(\d{4}\.\d{2}-r\d+)/);
        if (!cancelled && m) setAppVersion(m[1]);
      })
      .catch(() => { /* 取得できない環境では表示しない */ });
    return () => { cancelled = true; };
  }, []);

  const storedStats = useMemo(() => statsOf(stored), [stored]);
  const loadedStats = useMemo(() => (loaded ? statsOf(loaded.works) : null), [loaded]);
  // 発行中の引き継ぎコードの残り秒数（表示用）。
  const handoverRemainingSec = issuedHandover
    ? Math.max(0, Math.floor((new Date(issuedHandover.expiresAt).getTime() - handoverNow) / 1000))
    : 0;
  const categoryOptions = useMemo(() => {
    const seen: string[] = [];
    for (const w of stored) if (!seen.includes(w.category)) seen.push(w.category);
    return seen;
  }, [stored]);

  // 条件を受け取って、絞り込み＋並び替えした一覧を返す（適用済みの一覧用）。
  type FilterValues = {
    query: string;
    viewKey: string;
    categoryFilter: string;
    sortKey: string;
    flags: Record<'favorite' | 'completed' | 'adult' | 'hidden', FlagMode>;
  };
  const listFor = (values: FilterValues): Work[] => {
    const views: Record<string, (w: Work) => boolean> = {
      all: () => true,
      check: w => !w.isCompleted,
      unread: hasUnread,
      caughtup: isCaughtUp,
      finished: isFinishedReading,
      notfinished: w => !isFinishedReading(w),
    };
    const flagValue: Record<string, (w: Work) => boolean> = {
      favorite: w => w.favorite,
      completed: w => w.isCompleted,
      adult: w => w.hasAdult,
      hidden: w => w.isHidden,
    };
    const flagOk = (w: Work) => (Object.keys(values.flags) as (keyof typeof values.flags)[]).every(k => {
      const mode = values.flags[k];
      return mode === 'any' || (mode === 'only') === flagValue[k](w);
    });
    const q = values.query.trim().toLowerCase();
    const list = stored.filter(w =>
      flagOk(w) &&
      (views[values.viewKey] ?? views.all)(w) &&
      (values.categoryFilter === 'all' || w.category === values.categoryFilter) &&
      (q === '' || w.title.toLowerCase().includes(q) || w.memo.toLowerCase().includes(q)),
    );
    const sorted = [...list];
    // 並び替え: どのキーでも両方向を選べる。同点の場合は、主キーの向きに合わせた
    // 保存順にする（新しい順なら保存も新しい順、古い順なら保存も古い順）。
    // 日付なしは「最も古い」扱いにする（新しい順では末尾、古い順では先頭）。
    // 残りは、最大が未確認で計算できない作品を、多い順・少ない順のどちらでも末尾に置く。
    const savedIndex = new Map(sorted.map((w, i) => [w.id, i]));
    const withTieBreak = (cmp: (a: Work, b: Work) => number, dir: 1 | -1) =>
      (a: Work, b: Work) => cmp(a, b) || dir * ((savedIndex.get(a.id) ?? 0) - (savedIndex.get(b.id) ?? 0));
    const byDate = (get: (w: Work) => string | null, dir: 1 | -1) =>
      (a: Work, b: Work) => dir * (get(a) ?? '').localeCompare(get(b) ?? '');
    const byUnread = (dir: 1 | -1) => (a: Work, b: Work) => {
      const ua = unreadX10(a);
      const ub = unreadX10(b);
      if (ua === null && ub === null) return 0;
      if (ua === null) return 1;
      if (ub === null) return -1;
      return dir * (ua - ub);
    };
    switch (values.sortKey) {
      case 'orderDesc': sorted.reverse(); break;
      case 'titleAsc': sorted.sort(withTieBreak((a, b) => a.title.localeCompare(b.title, 'ja'), 1)); break;
      case 'titleDesc': sorted.sort(withTieBreak((a, b) => b.title.localeCompare(a.title, 'ja'), -1)); break;
      case 'unreadDesc': sorted.sort(withTieBreak(byUnread(-1), -1)); break;
      case 'unreadAsc': sorted.sort(withTieBreak(byUnread(1), 1)); break;
      case 'progressDesc': sorted.sort(withTieBreak(byDate(w => w.lastProgressDate, -1), -1)); break;
      case 'progressAsc': sorted.sort(withTieBreak(byDate(w => w.lastProgressDate, 1), 1)); break;
      case 'checkAsc': sorted.sort(withTieBreak(byDate(w => w.lastCheckedDate, 1), 1)); break;
      case 'checkDesc': sorted.sort(withTieBreak(byDate(w => w.lastCheckedDate, -1), -1)); break;
      default: break; // orderAsc は保存順のまま
    }
    return sorted;
  };

  const sortedVisible = useMemo(() => listFor({
    query,
    viewKey,
    categoryFilter,
    sortKey,
    flags: flagFilters,
  }), [stored, flagFilters, viewKey, categoryFilter, query, sortKey]);

  // 表示順の固定: 並び順が値に依存する場合（残り順・最終進捗日順など）、進捗や
  // 日付の変更でその場で並び替えると、操作中のカードが移動して誤操作の原因になる。
  // そのため、適用済みの絞り込み・並び順の条件と、作品の顔ぶれ（IDの並び）が
  // 変わったときだけ表示順を計算し直し、それ以外のデータ変更では順番と顔ぶれを
  // 固定したまま、カードの中身（進捗・日付など）だけを最新の値に追随させる。
  const storedIdSignature = stored.map(w => w.id).join(',');
  const displayKey = JSON.stringify([
    query,
    viewKey,
    categoryFilter,
    sortKey,
    flagFilters,
    storedIdSignature,
  ]);
  const [displayState, setDisplayState] = useState<{
    key: string;
    ids: string[];
  } | null>(null);
  if (displayState === null || displayState.key !== displayKey) {
    // 条件が変わったときだけ、表示中のレンダーで state を調整して並び直す
    // （エフェクトで直すと、一瞬だけ古い並びが描画されてしまうため）。
    setDisplayState({
      key: displayKey,
      ids: sortedVisible.map(w => w.id),
    });
  }
  const visible = displayState !== null && displayState.key === displayKey
    ? displayState.ids
      .map(id => stored.find(w => w.id === id))
      .filter((w): w is Work => w !== undefined)
    : sortedVisible;

  // 絞り込みが既定以外になっているか（検索ボタンのドット表示と、リセットの可否に使う）
  const filtersActive =
    query.trim() !== '' || viewKey !== 'all' || categoryFilter !== 'all' || sortKey !== 'orderDesc' ||
    flagFilters.favorite !== 'any' || flagFilters.completed !== 'any' ||
    flagFilters.adult !== 'any' || flagFilters.hidden !== 'exclude';

  // 下書きを適用済みの条件から作り直す（パネル／モーダルを開くときに呼ぶ）。
  function snapshotDraft() {
    setDraftQuery(query);
    setDraftViewKey(viewKey);
    setDraftCategoryFilter(categoryFilter);
    setDraftSortKey(sortKey);
    setDraftFlagFilters(flagFilters);
  }

  // 下書きを適用済みに反映する。PCのアコーディオンでは検索ボックスが適用済みを
  // 直接編集しているため、検索語は下書きで上書きしない（includeQuery = false）。
  function applyDraft(includeQuery: boolean) {
    if (includeQuery) setQuery(draftQuery);
    setViewKey(draftViewKey);
    setCategoryFilter(draftCategoryFilter);
    setSortKey(draftSortKey);
    setFlagFilters(draftFlagFilters);
  }

  // 下書きが適用済みと違うか（未適用の変更の表示と、適用ボタンの可否に使う）。
  const draftFlagsDirty =
    (Object.keys(flagFilters) as (keyof typeof flagFilters)[]).some(k => draftFlagFilters[k] !== flagFilters[k]);
  const draftDirtyPanel =
    draftViewKey !== viewKey || draftCategoryFilter !== categoryFilter ||
    draftSortKey !== sortKey || draftFlagsDirty;
  const draftDirtyModal = draftDirtyPanel || draftQuery !== query;

  // 適用済みの並び順の表示名（アコーディオンの見出しに出す）。
  const appliedSortLabel = SORT_OPTIONS.find(o => o.value === sortKey)?.label ?? '';

  function resetFilters() {
    setQuery('');
    setViewKey('all');
    setCategoryFilter('all');
    setSortKey('orderDesc');
    setFlagFilters({
      favorite: 'any',
      completed: 'any',
      adult: 'any',
      hidden: 'exclude',
    });
    setDraftQuery('');
    setDraftViewKey('all');
    setDraftCategoryFilter('all');
    setDraftSortKey('orderDesc');
    setDraftFlagFilters({
      favorite: 'any',
      completed: 'any',
      adult: 'any',
      hidden: 'exclude',
    });
  }

  // PCのアコーディオンの開閉: 開くときに下書きを作り直す。
  function toggleFilterPanel() {
    if (!showFilterPanel) snapshotDraft();
    setShowFilterPanel(!showFilterPanel);
  }

  // 一覧の先頭へ滑らかに戻る
  function scrollToTop() {
    window.scrollTo({
      top: 0,
      behavior: 'smooth',
    });
  }

  // 検索モーダルの「適用」: 下書きを適用して閉じ、一覧の先頭へ戻る
  function showSearchResults() {
    applyDraft(true);
    setShowSearch(false);
    scrollToTop();
  }

  async function onFile(file: File) {
    setError(null);
    setSavedNote(null);
    setLoadedFromCloud(null);
    try {
      const text = decodeTextBuffer(await file.arrayBuffer());
      if (file.name.toLowerCase().endsWith('.json')) {
        setLoaded({ works: worksFromJson(text), sourceName: file.name, format: 'json' });
      } else {
        setLoaded({ works: parseNewCsv(text), sourceName: file.name, format: 'new' });
      }
    } catch (e) {
      setLoaded(null);
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function saveImport(mode: 'merge' | 'replace') {
    if (!loaded) return;
    const plan: ImportPlan = planImport(stored, loaded.works, mode);
    await applyImport(plan, mode);
    setSavedNote(
      mode === 'replace'
        ? `保存しました: 全${plan.added}件を入れ替えました`
        : `保存しました: 追加 ${plan.added}件 / 更新 ${plan.updated}件 / 変更なし ${plan.unchanged}件`,
    );
    if (loadedFromCloud) {
      // クラウドから読み込んだ分は、その時点のクラウドの状態を把握済みとして記録する。
      const now = new Date().toISOString();
      setCloudRemoteUpdatedAt(loadedFromCloud.updatedAt);
      setCloudLastSyncedAt(now);
      setCloudLastSynced(now);
      setCloudRemoteMeta(loadedFromCloud);
      setLoadedFromCloud(null);
      setCloudNote('クラウドから読み込みました。');
    }
    // 引き継ぎコード経由の取り込みでも、保存が終われば案内文は消す。
    setHandoverNote(null);
    setLoaded(null);
  }

  // ----- クラウド同期（手動のみ。自動同期はしない） -----

  async function handleCloudConnect(provider: CloudProvider) {
    setCloudError(null);
    setCloudNote(null);
    setCloudBusy('接続しています…');
    try {
      await provider.connect();
      setActiveCloudProviderId(provider.id);
      setCloudProviderId(provider.id);
      setCloudConnected(true);
      const meta = await provider.findSyncFile();
      setCloudRemoteMeta(meta);
      setCloudNote(meta
        ? `${provider.label}に接続しました。クラウドには ${formatCloudDateTime(meta.updatedAt)} 更新の同期ファイルがあります。`
        : `${provider.label}に接続しました。クラウドにはまだ同期ファイルがありません。`);
    } catch (e) {
      setCloudError(e instanceof Error ? e.message : String(e));
    } finally {
      setCloudBusy(null);
    }
  }

  function handleCloudDisconnect() {
    if (!activeCloudProvider) return;
    activeCloudProvider.disconnect();
    clearCloudSyncState();
    setCloudProviderId(null);
    setCloudConnected(false);
    setCloudRemoteMeta(null);
    setCloudLastSynced(null);
    setLoadedFromCloud(null);
    setCloudError(null);
    setCloudNote('クラウド同期の接続を解除しました。クラウド上のファイルは消えていません。');
  }

  // 保存・読み込み・コピーの共通前処理: 接続が切れていたら繋ぎ直す。
  async function ensureCloudConnected(provider: CloudProvider): Promise<void> {
    if (!provider.isConnected()) await provider.connect();
    setCloudConnected(true);
  }

  async function handleCloudSave(force: boolean) {
    const provider = activeCloudProvider;
    if (!provider) return;
    setCloudError(null);
    setCloudNote(null);
    setCloudBusy('クラウドを確認しています…');
    try {
      await ensureCloudConnected(provider);
      const meta = await provider.findSyncFile();
      setCloudRemoteMeta(meta);
      if (!force && meta && meta.updatedAt !== getCloudRemoteUpdatedAt()) {
        // この端末が把握している版とクラウドの実物が違う＝他の端末で
        // 更新された可能性があるため、上書き前に確認する。
        setConfirmingCloudOverwrite(true);
        return;
      }
      setCloudBusy('クラウドに保存しています…');
      const saved = await provider.uploadSyncFile(worksToJson(stored), meta);
      const now = new Date().toISOString();
      setCloudRemoteUpdatedAt(saved.updatedAt);
      setCloudLastSyncedAt(now);
      setCloudLastSynced(now);
      setCloudRemoteMeta(saved);
      setCloudNote(`${provider.label}に保存しました（${formatCloudDateTime(saved.updatedAt)}）。`);
    } catch (e) {
      setCloudError(e instanceof Error ? e.message : String(e));
    } finally {
      setCloudBusy(null);
    }
  }

  async function handleCloudLoad() {
    const provider = activeCloudProvider;
    if (!provider) return;
    setCloudError(null);
    setCloudNote(null);
    setCloudBusy('クラウドから読み込んでいます…');
    try {
      await ensureCloudConnected(provider);
      const meta = await provider.findSyncFile();
      setCloudRemoteMeta(meta);
      if (!meta) {
        setCloudError('クラウドにはまだ同期ファイルがありません。先に「クラウドに保存」を実行してください。');
        return;
      }
      const text = await provider.downloadSyncFile(meta.id);
      setLoaded({ works: worksFromJson(text), sourceName: `${provider.label} の同期ファイル`, format: 'json' });
      setLoadedFromCloud(meta);
      setCloudNote('クラウドの内容を取り込み待ちにしました。確認欄で保存方法を選んでください。');
    } catch (e) {
      setLoadedFromCloud(null);
      setCloudError(e instanceof Error ? e.message : String(e));
    } finally {
      setCloudBusy(null);
    }
  }

  // ----- 引き継ぎコード（実験的） -----

  async function handleHandoverIssue() {
    setHandoverError(null);
    setHandoverNote(null);
    setHandoverBusy('引き継ぎコードを発行しています…');
    try {
      const issued = await issueHandover(worksToJson(stored));
      // QRはアプリ内では読み取らず、スマホのカメラでURLを開く前提。
      const url = `${window.location.origin}${window.location.pathname}#handover=${issued.code}`;
      const qr = qrcode(0, 'M');
      qr.addData(url);
      qr.make();
      const qrSvg = qr.createSvgTag({ cellSize: 4, margin: 4, scalable: true });
      setIssuedHandover({ ...issued, qrSvg });
      setHandoverNow(Date.now());
    } catch (e) {
      setHandoverError(e instanceof Error ? e.message : String(e));
    } finally {
      setHandoverBusy(null);
    }
  }

  async function handleHandoverCopy() {
    if (!issuedHandover) return;
    setHandoverError(null);
    try {
      // コピーするのは区切りを含まない10文字そのもの。
      await navigator.clipboard.writeText(issuedHandover.code);
      showTransientHandoverNote('コードをコピーしました。');
    } catch {
      setHandoverError('コピーできませんでした。コードを直接選択してコピーしてください。');
    }
  }

  async function handleHandoverCancel() {
    if (!issuedHandover) return;
    const code = issuedHandover.code;
    setIssuedHandover(null);
    await cancelHandover(code);
    showTransientHandoverNote('引き継ぎコードを取り消しました。');
  }

  async function handleHandoverRedeem() {
    const code = redeemCode.trim().toUpperCase();
    if (!/^[2-9A-HJKMNP-Z]{10}$/.test(code)) {
      setHandoverError('10文字のコードを入力してください。');
      return;
    }
    setHandoverError(null);
    setHandoverNote(null);
    setHandoverBusy('引き継ぎコードで受け取っています…');
    try {
      const text = await redeemHandover(code);
      setLoaded({ works: worksFromJson(text), sourceName: '引き継ぎコード', format: 'json' });
      setLoadedFromCloud(null);
      setRedeemCode('');
      setHandoverNote('引き継ぎコードの内容を取り込み待ちにしました。確認欄で保存方法を選んでください。');
    } catch (e) {
      setHandoverError(e instanceof Error ? e.message : String(e));
    } finally {
      setHandoverBusy(null);
    }
  }

  async function confirmClearAll() {
    setConfirmingClear(false);
    setShowSettings(false);
    await clearAllData();
    setSavedNote('保存済みデータをすべて削除しました');
  }

  // ----- ライブラリ操作（いずれも取り消し用スナップショットを保持し、確認ダイアログは出さない） -----

  function indexOf(w: Work) {
    return stored.findIndex(x => x.id === w.id);
  }

  async function onStep(w: Work, deltaX10: number) {
    const next = stepProgress(w, deltaX10, todayLocal());
    if (next === w) return;
    await updateWork(next);
    setToast({
      message: next.maxX10 !== w.maxX10
        ? `「${w.title}」の進捗を ${formatX10(w.progressX10)} → ${formatX10(next.progressX10)} に変更し、最大も ${formatX10(next.maxX10)} に合わせました`
        : `「${w.title}」の進捗を ${formatX10(w.progressX10)} → ${formatX10(next.progressX10)} に変更しました`,
      work: w, index: indexOf(w), deleted: false,
    });
  }

  async function confirmCheck(maxX10: number | null) {
    const w = checking;
    setChecking(null);
    if (!w) return;
    const today = todayLocal();
    const next = applyCheck(w, maxX10, today);
    if (next === w) return;
    await updateWork(next);
    setToast({
      message: next.maxX10 !== w.maxX10
        ? `「${w.title}」の最大を ${w.maxX10 === null ? '未確認' : formatX10(w.maxX10)} → ${formatX10(next.maxX10)} に変更し、最終チェック日を記録しました`
        : `「${w.title}」を確認済みにしました（最終チェック日 = ${today}）`,
      work: w, index: indexOf(w), deleted: false,
    });
  }

  async function onDelete(w: Work) {
    const idx = indexOf(w);
    await removeWork(w.id);
    setToast({ message: `「${w.title}」を削除しました`, work: w, index: idx, deleted: true });
  }

  async function onUndo() {
    if (!toast) return;
    if (toast.deleted) await restoreWork(toast.work, toast.index);
    else await updateWork(toast.work);
    setToast(null);
  }

  async function handleFormSave(draft: Work) {
    const today = todayLocal();
    if (editing?.mode === 'edit') {
      await updateWork(applyEdits(editing.original, draft, today));
    } else {
      let w: Work = { ...draft, id: crypto.randomUUID() };
      // 新規登録では最終進捗日・最終チェック日とも今日を入れる（手で指定した日付はそちらを優先）。
      if (w.lastProgressDate === null) w = { ...w, lastProgressDate: today };
      if (w.lastCheckedDate === null) w = { ...w, lastCheckedDate: today };
      await saveNewWork(w);
    }
    setEditing(null);
  }

  function blankWork(): Work {
    return {
      id: '', title: '', category, unit,
      progressX10: 0, maxX10: null,
      favorite: false, isCompleted: false, isHidden: false, hasAdult: false,
      lastCheckedDate: null, lastProgressDate: null, memo: '',
    };
  }

  // 件数サマリ: ページ上と検索モーダルで同じ部品を使う（狭い画面ではページ上は隠し、モーダル内だけに出す）
  const summaryLine = (
    <section className="summary" aria-label="概要">
      <span>全 {storedStats.total} 件</span>
      <span>★ {storedStats.favorite}</span>
      <span>完結 {storedStats.completed}</span>
      <span>アダルト {storedStats.adult}</span>
      <span>非表示 {storedStats.hidden}</span>
    </section>
  );

  // 絞り込みの選択肢一式（検索ボックスを除く）: 適用済みではなく下書きを編集する。
  // PCのアコーディオンと検索モーダル（狭い画面）で同じ部品を使う。
  const filterFields = (
    <div className="filterRow">
      <label>表示
        <select value={draftViewKey} onChange={e => setDraftViewKey(e.target.value)}>
          <option value="all">すべて</option>
          <option value="check">要チェック（未完結）</option>
          <option value="unread">残りあり</option>
          <option value="caughtup">追いつき</option>
          <option value="finished">完了した作品（完結・残りなし）</option>
          <option value="notfinished">完了した作品を除く</option>
        </select>
      </label>
      <label>カテゴリ
        <select value={draftCategoryFilter} onChange={e => setDraftCategoryFilter(e.target.value)}>
          <option value="all">すべて</option>
          {draftCategoryFilter !== 'all' && !categoryOptions.includes(draftCategoryFilter) && (
            <option value={draftCategoryFilter}>{draftCategoryFilter}</option>
          )}
          {categoryOptions.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
      </label>
      <label>並び順
        <select value={draftSortKey} onChange={e => setDraftSortKey(e.target.value)}>
          {SORT_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </label>
      {([['favorite', 'お気に入り'], ['completed', '完結'], ['adult', 'アダルト'], ['hidden', '非表示']] as const).map(([key, label]) => (
        <label key={key}>{label}
          <select
            value={draftFlagFilters[key]}
            onChange={e => setDraftFlagFilters(f => ({ ...f, [key]: e.target.value as FlagMode }))}
          >
            <option value="any">指定なし</option>
            <option value="only">のみ表示</option>
            <option value="exclude">非表示</option>
          </select>
        </label>
      ))}
    </div>
  );

  return (
    <div className="app">
      <header className="appHeader">
        <div className="brand">
          <img className="brandLogo" src="/season-log-icon.svg" alt="" />
          <div>
            <h1>Season Log</h1>
            <p className="tagline">進めかけも、完結も。コンテンツの進捗を記録する</p>
          </div>
        </div>
        <div className="headerActions">
          <button className="btn btnPrimary addBtn" onClick={() => setEditing({ mode: 'new' })}>＋ 新規登録</button>
          <button className="settingsBtn" onClick={() => { setSettingsTab('general'); setShowSettings(true); }} aria-label="設定を開く" title="設定">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>
          </button>
        </div>
      </header>
      {showToTop && (
        <button className="toTopBtn" onClick={() => {
          window.scrollTo({
            top: 0,
            behavior: 'smooth',
          });
        }} aria-label="先頭へ戻る" title="先頭へ戻る">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><line x1="12" y1="19" x2="12" y2="5"></line><polyline points="5 12 12 5 19 12"></polyline></svg>
        </button>
      )}
      <button className="fabAdd" onClick={() => setEditing({ mode: 'new' })} aria-label="新規登録" title="新規登録">
        <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
      </button>
      <button className={`searchFab${filtersActive ? ' hasActive' : ''}`} onClick={() => { snapshotDraft(); setShowSearch(true); }} aria-label="検索と絞り込みを開く" title="検索と絞り込み">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"></circle><line x1="21" y1="21" x2="16.5" y2="16.5"></line></svg>
      </button>

      {showSettings && (
        <Modal title="設定" wide onClose={() => setShowSettings(false)}>
          <div className="settingsTabs" role="tablist" aria-label="設定の分類">
            {([
              ['general', '一般'],
              ['data', 'データ管理'],
              ['cloud', 'クラウド同期'],
            ] as const).map(([key, label]) => (
              <button key={key} type="button" role="tab" aria-selected={settingsTab === key} className={`settingsTabBtn${settingsTab === key ? ' active' : ''}`} onClick={() => setSettingsTab(key)}>{label}</button>
            ))}
          </div>
          {settingsTab === 'general' && (
            <>
              <section className="settingsSection">
                <h2 className="settingsSubheading">テーマ</h2>
                <p className="note">アプリの外観切り替え</p>
                <div className="themeToggleGroup" role="radiogroup" aria-label="テーマ">
                  <button type="button" className={`themeToggleBtn${themePref === 'light' ? ' active' : ''}`} role="radio" aria-checked={themePref === 'light'} onClick={() => setThemePref('light')}>
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="5"></circle><line x1="12" y1="1" x2="12" y2="3"></line><line x1="12" y1="21" x2="12" y2="23"></line><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line><line x1="1" y1="12" x2="3" y2="12"></line><line x1="21" y1="12" x2="23" y2="12"></line><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line></svg>
                    <span>ライト</span>
                  </button>
                  <button type="button" className={`themeToggleBtn${themePref === 'system' ? ' active' : ''}`} role="radio" aria-checked={themePref === 'system'} onClick={() => setThemePref('system')}>
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><path d="M12 2a10 10 0 0 1 0 20Z" fill="currentColor"></path></svg>
                    <span>システム</span>
                  </button>
                  <button type="button" className={`themeToggleBtn${themePref === 'dark' ? ' active' : ''}`} role="radio" aria-checked={themePref === 'dark'} onClick={() => setThemePref('dark')}>
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path></svg>
                    <span>ダーク</span>
                  </button>
                </div>
              </section>
              <section className="settingsSection">
                <h2 className="settingsSubheading">新規登録の既定</h2>
                <p className="note">新規登録のときに、最初に選ばれているカテゴリと進捗単位です。</p>
                <div className="panelRow">
                  <label>カテゴリ
                    <select value={category} onChange={e => setCategory(e.target.value)}>
                      {!CATEGORIES.includes(category) && <option>{category}</option>}
                      {CATEGORIES.map(c => <option key={c}>{c}</option>)}
                    </select>
                  </label>
                  <label>進捗単位
                    <select value={unit} onChange={e => setUnit(e.target.value)}>
                      {!UNITS.includes(unit) && <option>{unit}</option>}
                      {UNITS.map(u => <option key={u}>{u}</option>)}
                    </select>
                  </label>
                </div>
              </section>
            </>
          )}
          {settingsTab === 'data' && (
            <section className="settingsSection">
              <h3>ファイルを取り込む</h3>
              <p className="note">本アプリが出力したCSV、またはJSONバックアップを取り込めます。</p>
              <div className="panelRow">
                <input
                  type="file"
                  accept=".csv,.txt,.json"
                  onChange={e => { const f = e.target.files?.[0]; if (f) void onFile(f); e.target.value = ''; }}
                />
              </div>
              <h3>他の端末への引き継ぎ（実験的）</h3>
              <p className="note">サーバーを経由して、他の端末へデータを1回だけ渡せます。コードは10分で失効し、受け取りが完了した時点でも消えます。データは最大10分間だけサーバーに置かれます。コードを知っている人は誰でも受け取れるため、コードは他の人に見せないでください。この機能は実験的なもので、予告なく終了することがあります。</p>
              {!issuedHandover && (
                <div className="panelRow">
                  <button className="btn" disabled={handoverBusy !== null || stored.length === 0} onClick={() => void handleHandoverIssue()}>引き継ぎコードを発行</button>
                </div>
              )}
              {issuedHandover && (
                <div className="handoverIssued">
                  <p className="handoverCode"><span>{issuedHandover.code.slice(0, 5)}</span><span>{issuedHandover.code.slice(5)}</span></p>
                  <div className="handoverQr" dangerouslySetInnerHTML={{ __html: issuedHandover.qrSvg }} />
                  <p className="note">
                    有効期限: {new Date(issuedHandover.expiresAt).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}（残り {Math.floor(handoverRemainingSec / 60)}分{String(handoverRemainingSec % 60).padStart(2, '0')}秒）<br />
                    受け取る端末でこのコードを入力するか、QRコードをカメラで読み取って開いてください。受け取りが終わったら、この画面は閉じてかまいません。
                  </p>
                  <div className="panelRow">
                    <button className="btn" disabled={handoverBusy !== null} onClick={() => void handleHandoverCopy()}>コードをコピー</button>
                    <button className="btn" disabled={handoverBusy !== null} onClick={() => void handleHandoverCancel()}>このコードを取り消す</button>
                  </div>
                </div>
              )}
              <div className="panelRow">
                <input
                  type="text"
                  autoComplete="one-time-code"
                  autoCapitalize="characters"
                  placeholder="10文字のコード"
                  value={redeemCode}
                  onChange={e => setRedeemCode(e.target.value.replace(/[^0-9a-zA-Z]/g, '').toUpperCase().slice(0, 10))}
                />
                <button className="btn btnPrimary" disabled={handoverBusy !== null || redeemCode.length !== 10} onClick={() => void handleHandoverRedeem()}>受け取る</button>
              </div>
              {handoverBusy && <p className="note" role="status">{handoverBusy}</p>}
              {handoverError && <p className="error" role="alert">{handoverError}</p>}
              {handoverNote && <p className="ok">{handoverNote}</p>}
              <h3>保存済みデータの書き出し・削除</h3>
              <div className="panelRow">
                <button className="btn" onClick={() => download('season-log.csv', worksToCsv(stored), 'text/csv')} disabled={stored.length === 0}>CSVをダウンロード</button>
                <button className="btn" onClick={() => download('season-log.json', worksToJson(stored), 'application/json')} disabled={stored.length === 0}>JSONをダウンロード</button>
                <button className="btn danger" onClick={() => setConfirmingClear(true)} disabled={stored.length === 0}>全データ削除</button>
              </div>
              <p className="note">データはこのブラウザに保存されています（IndexedDB）。ブラウザのデータ削除で消えてしまうことがあるため、定期的なバックアップをおすすめします。バックアップや他の端末への移行には、JSONまたはCSVのダウンロードをご利用ください。</p>
            </section>
          )}
          {settingsTab === 'cloud' && (
            <section className="settingsSection">
              {!activeCloudProvider && (
                <>
                  <p className="note">JSONバックアップをクラウドに保存して、他の端末と受け渡しできます。同期はボタンを押したときだけ行います（自動同期はしません）。</p>
                  <div className="panelRow">
                    {CLOUD_PROVIDERS.map(p => (
                      <button key={p.id} className="btn" disabled={cloudBusy !== null || !p.isConfigured()} onClick={() => void handleCloudConnect(p)}>{p.label}に接続</button>
                    ))}
                  </div>
                  {CLOUD_PROVIDERS.some(p => !p.isConfigured()) && (
                    <p className="note">未設定のクラウドは利用できません（デプロイ環境の環境変数で、接続に必要なIDを設定してください）。</p>
                  )}
                </>
              )}
              {activeCloudProvider && (
                <>
                  <p className="note">
                    接続先: {activeCloudProvider.label}（{cloudConnected ? '接続済み' : '未接続 — 操作時に自動で接続します'}）
                    {cloudLastSynced && <><br />最終同期: {formatCloudDateTime(cloudLastSynced)}</>}
                    {cloudRemoteMeta && <><br />クラウドの同期ファイル: {formatCloudDateTime(cloudRemoteMeta.updatedAt)} 更新</>}
                  </p>
                  <div className="panelRow">
                    <button className="btn btnPrimary" disabled={cloudBusy !== null || stored.length === 0} onClick={() => void handleCloudSave(false)}>クラウドに保存</button>
                    <button className="btn" disabled={cloudBusy !== null} onClick={() => void handleCloudLoad()}>クラウドから読み込む</button>
                    <button className="btn" disabled={cloudBusy !== null} onClick={handleCloudDisconnect}>接続を解除</button>
                  </div>
                  <p className="note">読み込むと、ファイルの取り込みと同じ確認欄が出て、保存方法（IDで照合／すべて入れ替え）を選べます。接続を解除しても、クラウド上のファイルは消えません。</p>
                </>
              )}
              {cloudBusy && <p className="note" role="status">{cloudBusy}</p>}
              {cloudError && <p className="error" role="alert">{cloudError}</p>}
              {cloudNote && <p className="ok">{cloudNote}</p>}
            </section>
          )}
          {/* 取り込み待ちの確認欄は、どのタブでも見えるよう共通の位置に出す
              （クラウドから読み込んだ場合も、同じ確認欄を使うため）。 */}
          {error && <p className="error" role="alert">{error}</p>}
          {loaded && loadedStats && (
            <div className="importBox">
              <p>
                <strong>取り込み結果: {loaded.sourceName}</strong><br />
                形式: {loaded.format === 'new' ? 'CSV' : 'JSONバックアップ'} / {loadedStats.total}件<br />
                お気に入り {loadedStats.favorite} / 完結 {loadedStats.completed} / アダルト {loadedStats.adult} / 非表示 {loadedStats.hidden} / 日付あり {loadedStats.withDate} / 進捗が小数 {loadedStats.decimal}
              </p>
              <div className="panelRow">
                {stored.length === 0 && (
                  <button className="btn btnPrimary" onClick={() => void saveImport('replace')}>この内容で保存する</button>
                )}
                {stored.length > 0 && (
                  <>
                    <button className="btn btnPrimary" onClick={() => void saveImport('merge')}>IDで照合して保存（既存は更新・新規は追加）</button>
                    <button className="btn" onClick={() => void saveImport('replace')}>すべて入れ替えて保存</button>
                  </>
                )}
                <button className="btn" onClick={() => { setLoaded(null); if (loadedFromCloud) setCloudNote(null); setLoadedFromCloud(null); setHandoverNote(null); }}>保存しない</button>
              </div>
              <ul className="previewList">
                {loaded.works.slice(0, PREVIEW_ROWS).map(w => (
                  <li key={w.id}><span className="previewTitle">{w.title}</span><span className="previewMeta">{formatX10(w.progressX10)} / {w.maxX10 === null ? '—' : formatX10(w.maxX10)} {w.unit}</span></li>
                ))}
              </ul>
              {loaded.works.length > PREVIEW_ROWS && <p className="note">…ほか {loaded.works.length - PREVIEW_ROWS} 件（プレビューは先頭{PREVIEW_ROWS}件のみ）</p>}
            </div>
          )}
          {appVersion && <p className="versionLine">Ver {appVersion}</p>}
          <p className="privacyLine"><a href="/privacy.html">プライバシーポリシー</a></p>
        </Modal>
      )}

      {showSearch && (
        <Modal title="検索と絞り込み" onClose={() => setShowSearch(false)}>
          <input
            type="search"
            className="searchBox"
            value={draftQuery}
            onChange={e => setDraftQuery(e.target.value)}
            placeholder="タイトル・メモで検索"
          />
          {filterFields}
          {summaryLine}
          <div className="modalActions">
            <button className="btn" onClick={resetFilters} disabled={!filtersActive && !draftDirtyModal}>条件をリセット</button>
            <button className="btn btnPrimary" onClick={showSearchResults}>適用</button>
          </div>
        </Modal>
      )}

      {savedNote && <p className="ok banner">{savedNote}</p>}

      {summaryLine}

      <section className="filters" aria-label="検索と絞り込み">
        <input
          type="search"
          className="searchBox"
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="タイトル・メモで検索"
        />
        <div className="filterAccordion">
          <button type="button" className="filterAccordionHead" aria-expanded={showFilterPanel} onClick={toggleFilterPanel}>
            <span>並び順・絞り込み（現在: {appliedSortLabel}）</span>
            <span className="filterAccordionChevron" aria-hidden="true">{showFilterPanel ? '▲' : '▼'}</span>
          </button>
          {showFilterPanel && (
            <div className="filterPanel">
              {filterFields}
              <div className="filterPanelActions">
                <button className="btn" onClick={resetFilters} disabled={!filtersActive && !draftDirtyPanel}>条件をリセット</button>
                <button className="btn btnPrimary" onClick={() => applyDraft(false)} disabled={!draftDirtyPanel}>適用</button>
              </div>
            </div>
          )}
        </div>
      </section>
      <p className="countLine">全{storedStats.total}件中 {visible.length}件を表示</p>

      {stored.length === 0 ? (
        <section className="emptyState">
          <p>まだ作品が登録されていません。</p>
          <p className="note">右上の歯車ボタン（設定）にある「データ管理」から、これまでのデータをCSV / JSONで取り込むか、「＋ 新規登録」から最初の1件を登録してください。</p>
        </section>
      ) : visible.length === 0 ? (
        <section className="emptyState">
          <p>条件に合う作品がありません。</p>
          <p className="note">検索や絞り込みの条件を変えてみてください。</p>
        </section>
      ) : (
        <div className="cardList">
          {visible.map(w => (
            <WorkCard
              key={w.id}
              work={w}
              onStep={(work, d) => void onStep(work, d)}
              onCheck={work => setChecking(work)}
              onEdit={work => setEditing({ mode: 'edit', original: work })}
              onDelete={work => setConfirmingDelete(work)}
            />
          ))}
        </div>
      )}
      {flagFilters.hidden === 'exclude' && storedStats.hidden > 0 && (
        <p className="note">非表示の{storedStats.hidden}件は隠れています（絞り込みの「非表示」で切り替えられます）。</p>
      )}

      {editing && (
        <EditForm
          key={editing.mode === 'edit' ? editing.original.id : 'new'}
          initial={editing.mode === 'edit' ? editing.original : blankWork()}
          isNew={editing.mode === 'new'}
          existingWorks={stored}
          onSave={d => void handleFormSave(d)}
          onCancel={() => setEditing(null)}
        />
      )}

      {checking && (
        <CheckDialog
          work={checking}
          onConfirm={d => void confirmCheck(d)}
          onCancel={() => setChecking(null)}
        />
      )}

      {confirmingCloudOverwrite && activeCloudProvider && (
        <ConfirmDialog
          title="クラウド保存の確認"
          message={`クラウド上の同期ファイルは、この端末が最後に把握した状態より新しくなっています（${cloudRemoteMeta ? formatCloudDateTime(cloudRemoteMeta.updatedAt) : ''} 更新）。他の端末で更新された内容が、上書きで消える可能性があります。この端末の内容で上書きしますか？`}
          confirmLabel="上書きして保存する"
          onConfirm={() => { setConfirmingCloudOverwrite(false); void handleCloudSave(true); }}
          onCancel={() => setConfirmingCloudOverwrite(false)}
        />
      )}

      {confirmingClear && (
        <ConfirmDialog
          title="全データ削除"
          message={`保存済みの作品データ（全 ${stored.length} 件）をすべて削除します。この操作は元に戻せません。エクスポートしたCSV/JSONがあれば、そこから復元できます。`}
          confirmLabel="すべて削除する"
          onConfirm={() => void confirmClearAll()}
          onCancel={() => setConfirmingClear(false)}
        />
      )}

      {confirmingDelete && (
        <ConfirmDialog
          title="作品の削除"
          message={`「${confirmingDelete.title}」を削除します。削除直後の「元に戻す」でのみ取り消せます。`}
          confirmLabel="削除する"
          onConfirm={() => { const w = confirmingDelete; setConfirmingDelete(null); void onDelete(w); }}
          onCancel={() => setConfirmingDelete(null)}
        />
      )}

      {toast && (
        <div className="toast" role="status">
          <span>{toast.message}</span>
          <button onClick={() => void onUndo()}>元に戻す</button>
        </div>
      )}
    </div>
  );
}
