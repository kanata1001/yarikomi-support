import { appStyles as styles } from '../src/styles/appStyles';
import { AppProvider } from '../src/context/AppContext';
import QuestionScreen from '../src/screens/QuestionScreen';
import VocabCardScreen from '../src/screens/VocabCardScreen'; 
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';
import React, { useEffect, useMemo, useState } from 'react';
import { Alert, AppState, BackHandler, Image, Linking, Platform, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import ImageView from '../components/ZoomableImageViewer';
import YarikomiSplash from '../src/components/YarikomiSplash';
import { loadSubjectStats, saveQuizResult } from '../src/storageService';
import { recordAnswerForReview, pruneAndGetDueQuestionIds, getUpcomingDueCount, getScheduledReviewCount, resetReviewSchedule } from '../src/reviewReminderService';
import { RANKING_ENABLED } from '../src/rankingService';
import { PRIVACY_POLICY_URL, SUPPORT_EMAIL, SUPPORT_URL } from '../src/constants/links';
import { getOrCreateDeviceId, loadNickname, saveNickname, computeWeeklyAnsweredCount, submitScore, fetchLeaderboard, LeaderboardEntry } from '../src/rankingService';

// ── 分割済みモジュールからの読み込み ─────────────────────────
// 以前はこのファイル冒頭に70件近いJSON importと集計ロジックが
// すべて書かれていたが、src/ 以下に分離した。
import { COLORS } from '../src/constants/theme';
import { SUBJECT_META, SUBJECT_ADVICE } from '../src/constants/subjects';
import { DEFAULT_EXAM_SCHEDULE } from '../src/constants/examSchedule';
import {
  VALID_QUESTIONS, STANDALONE_QUESTIONS, AVAILABLE_YEARS,
  YEAR_QUESTION_COUNTS, YEAR_SUBJECTS, YEAR_SUBJECT_QUESTION_COUNTS,
  SUBJECT_TOPIC_QUESTION_COUNTS, SUBJECT_TYPE_QUESTION_COUNTS, VOCAB_DATA,
  SUBJECT_TOPIC_LIST, SUBJECT_TOPIC_IMPORTANCE, TopicImportanceTier,
  REVIEWABLE_QUESTIONS, getTopicDisplayLabel, SUBJECT_YEARS, isSubQuestionOnly,
} from '../src/data/questionsData';
import { QuizCount, QUIZ_COUNT_OPTIONS, DEFAULT_QUIZ_COUNT, isQuizCount } from '../src/constants/quizCount';
import { sampleRandom, nengo, getTodayStr, getStreak, daysUntil, categoryColor, barColor, getRate } from '../src/utils/helpers';
import { getImageUri } from '../src/utils/imageHelper';
import { SYMBOL_LABELS, isAnswerCorrect } from '../src/utils/answer';
import { shuffleQuestionList } from '../src/utils/shuffle';
import {
  SessionSnapshot, buildSnapshot, buildQuestionLookup, restoreQuestionList,
  saveSessionSnapshot, loadSessionSnapshot, clearSessionSnapshot,
} from '../src/sessionResumeService';
import { MenuIcon, MenuIconBox, MAIN_TABS } from '../src/components/icons/MenuIcon';
import { ProgressGauge, MasteryGrid } from '../src/components/ProgressGauge';
import { StorageErrorToast, showStorageErrorToast } from '../src/components/StorageErrorToast';
import { ExamEvent, StatsType, QuestionMode, VocabMode, MasteryBuckets, MainTab, IconName, TodayFiveRecord } from '../src/types/domain';

// 通知の表示挙動を設定（フォアグラウンドでもアラート表示）
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

// ── Android通知チャンネルの作成 ─────────────────────────────
// Android 8以降はチャンネルを明示的に作成しないと、音・バナー表示（ヘッドアップ通知）が
// 保証されないため、アプリ起動時に一度だけ作成しておく。
if (Platform.OS === 'android') {
  Notifications.setNotificationChannelAsync('default', {
    name: 'デフォルト',
    importance: Notifications.AndroidImportance.HIGH,
    sound: 'default',
    vibrationPattern: [0, 250, 250, 250],
  });
}

// ── 「途中から再開」：ID→問題の対応表（過去問＋補充問題を含む）──
const RESUME_QUESTION_LOOKUP = buildQuestionLookup(REVIEWABLE_QUESTIONS, STANDALONE_QUESTIONS);

const WRONG_ANSWERS_KEY = '@shindanshi_wrong_answers';
const WRONG_WORDS_KEY = '@shindanshi_wrong_words';
const EXAM_SCHEDULE_KEY = '@shindanshi_exam_schedule';
const DAILY_LOG_KEY = '@shindanshi_daily_log';
const SETTINGS_KEY = '@shindanshi_settings';
// ── 「今日の5問」：当日分の出題記録（同じ問題セットを保つため）──
const TODAY_FIVE_KEY = '@shindanshi_today_five';
// ── 進捗率用：これまでに一度でも解答したユニークな問題IDを保存するキー ──
const ANSWERED_QUESTION_IDS_KEY = '@shindanshi_answered_question_ids';
// ── 習熟度（連続正解数）を保存するキー ──
const MASTERY_KEY = '@shindanshi_mastery';
// ── 「習得済み」と判定する連続正解数のしきい値 ──
// 一度正解しただけでは復習リスト（wrongIds）から外さない。ここに達するまでは
// 間違いリストに残り続け、優先的に再出題される（＝進捗は「解けるようになってから」しかカウントしない）。
const MASTERY_STREAK_TARGET = 2;

// ── トピック別学習画面の「重要度」表示（★3段階）──
// 過去問の年カバレッジ（頻出度）に、二次試験との連動が客観的に確認できる論点への
// 加点を加味した統合指標。high=★★★／mid=★★☆／low=★☆☆
// （算出根拠はsrc/data/questionsData.tsのSUBJECT_TOPIC_IMPORTANCEコメント参照）
const ImportanceStars = ({ tier }: { tier: TopicImportanceTier }) => {
  const filled = tier === 'high' ? 3 : tier === 'mid' ? 2 : 1;
  return (
    <View style={{ flexDirection: 'row' }}>
      {[0, 1, 2].map((i) => (
        <Text key={i} style={{ fontSize: 12, lineHeight: 14, color: i < filled ? '#F5A623' : '#E2E8F0', marginRight: 1 }}>★</Text>
      ))}
    </View>
  );
};

// ── App本体：既存の全画面ロジック（元のexport default function App相当）──
// トースト表示を screen/mainTabに関わらず最前面に出せるよう、
// 一番下にある export default 関数の内側でラップして呼び出す構成にしている。
function AppInner() {
  // ── ナビゲーション：ボトムタブ（新規追加）＋従来のscreenスタック ──
  const [mainTab, setMainTab] = useState<MainTab>('practice');
  const [progressSubTab, setProgressSubTab] = useState<'analysis' | 'schedule'>('analysis');
  const [screen, setScreen] = useState('splash');
  const [activeTab, setActiveTab] = useState<'overview' | 'subjects'>('overview');
  const [howtoTab, setHowtoTab] = useState<'modes' | 'howto' | 'tips'>('modes');
  const [selectedSubject, setSelectedSubject] = useState('');
  const [selectedTopic, setSelectedTopic] = useState<string | null>(null);
  const [topicSubject, setTopicSubject] = useState<string | null>(null);
  const [practiceSubject, setPracticeSubject] = useState<string | null>(null);
  const [questionMode, setQuestionMode] = useState<QuestionMode>('random');
  const [questionList, setQuestionList] = useState<any[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  // ── 回答済み記録（問題ごとに保持し、前の問題の結果も見返せるようにする）──
  const [answeredRecords, setAnsweredRecords] = useState<{ [index: number]: { selectedIdx: number; isCorrect: boolean } }>({});
  // ── 統計・学習ログへの二重カウントを防ぐための集計済みインデックス ──
  const [countedIndices, setCountedIndices] = useState<Set<number>>(new Set());
  // ── 連続正解の演出：1回の学習セッション中だけ数える（launchQuestionsで0に戻す）。
  //    getStreak（学習日数の連続）・mastery（問題ごとの連続正解）とは別物。
  //    streakByIndex は「その問題に最初に答えた時点の連続数」を問題番号ごとに保持し、
  //    前の問題に戻っても表示がぶれないようにする ──
  const [sessionCorrectStreak, setSessionCorrectStreak] = useState(0);
  const [streakByIndex, setStreakByIndex] = useState<{ [index: number]: number }>({});
  // ── 途中から再開：保存されている中断中のセッション（なければnull）──
  const [resumeSnapshot, setResumeSnapshot] = useState<SessionSnapshot | null>(null);
  const [showExplanation, setShowExplanation] = useState(false);
  const [showQuestionImage, setShowQuestionImage] = useState(true);
  // ── 画像の拡大表示 ──────────────────────────
  const [zoomVisible, setZoomVisible] = useState(false);
  const [zoomImages, setZoomImages] = useState<{ uri: string }[]>([]);
  const [zoomIndex, setZoomIndex] = useState(0);
  // ── 設定：回答後に解説をデフォルトで自動表示するか ──
  const [autoShowExplanation, setAutoShowExplanation] = useState(true);
  // ── 設定：毎日「今日の5問」プッシュ通知 ──
  const [dailyReminderEnabled, setDailyReminderEnabled] = useState(false);
  const [dailyReminderHour, setDailyReminderHour] = useState(20);
  const [dailyReminderMinute, setDailyReminderMinute] = useState(0);
  const [dailyReminderNotificationId, setDailyReminderNotificationId] = useState<string | null>(null);
  // ── 設定：「今日の5問」の1日あたりの出題数（5問 or 10問）──
  const [todayFiveCount, setTodayFiveCount] = useState<5 | 10>(5);
  // ── 「今日の5問」：当日分の出題記録（未生成の日はnull）──
  const [todayFiveRecord, setTodayFiveRecord] = useState<TodayFiveRecord | null>(null);
  // ── 設定：忘却曲線に基づく「復習リマインダー」(1日1件の集約通知) ──
  const [reviewRemindersEnabled, setReviewRemindersEnabled] = useState(false);
  const [reviewReminderHour, setReviewReminderHour] = useState(9);
  const [reviewReminderMinute, setReviewReminderMinute] = useState(0);
  const [reviewReminderNotificationId, setReviewReminderNotificationId] = useState<string | null>(null);
  // 弱点診断の可視化：現在「復習待ちリスト」に何問登録されているかを設定画面に表示するための参考値。
  // (通知のON/OFFに関わらず、間違えた・未習得の問題数の目安として常に見せる)
  const [scheduledReviewCount, setScheduledReviewCount] = useState<number>(0);

  // ── ユーザー間ランキング：匿名deviceId・ニックネーム・取得済みランキング ──
  const [rankingDeviceId, setRankingDeviceId] = useState<string>('');
  const [rankingNickname, setRankingNickname] = useState<string>('');
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);
  const [leaderboardTotal, setLeaderboardTotal] = useState<number>(0);
  const [rankingLoading, setRankingLoading] = useState<boolean>(false);
  const [rankingError, setRankingError] = useState<string>('');
  const [selectedYear, setSelectedYear] = useState<string | null>(null);
  // ── 出題数（全モード共通）。'all' は絞り込み後の全問題。設定として端末に保存する ──
  const [quizCount, setQuizCount] = useState<QuizCount>(DEFAULT_QUIZ_COUNT);
  // ── 過去問：科目を先に選び、その科目で出題する年度を複数選ぶ ──
  const [pastSubject, setPastSubject] = useState<string | null>(null);
  const [pastSelectedYears, setPastSelectedYears] = useState<string[]>([]);
  const [wrongIds, setWrongIds] = useState<Set<string>>(new Set());
  // ── 進捗率計算用：これまでに一度でも解答したユニークな問題ID ──
  const [answeredQuestionIds, setAnsweredQuestionIds] = useState<Set<string>>(new Set());
  // ── 習熟度：問題IDごとの連続正解数（0〜1=要復習,2=ほぼ理解,3以上=完璧）──
  const [mastery, setMastery] = useState<{ [id: string]: number }>({});
  const [stats, setStats] = useState<StatsType>({
    '経済学・経済政策': { total: 0, correct: 0 },
    '財務・会計': { total: 0, correct: 0 },
    '企業経営理論': { total: 0, correct: 0 },
    '運営管理': { total: 0, correct: 0 },
    '経営法務': { total: 0, correct: 0 },
    '経営情報システム': { total: 0, correct: 0 },
    '中小企業経営・中小企業政策': { total: 0, correct: 0 },
  });

  // 単語学習用 state
  const [vocabSubject, setVocabSubject] = useState<string | null>(null);
  const [vocabMode, setVocabMode] = useState<VocabMode>('random');
  const [vocabList, setVocabList] = useState<any[]>([]);
  const [vocabIndex, setVocabIndex] = useState(0);
  const [vocabFlipped, setVocabFlipped] = useState(false);
  const [wrongWordIds, setWrongWordIds] = useState<Set<string>>(new Set());
  const [vocabKnownCount, setVocabKnownCount] = useState(0);
  const [vocabUnknownCount, setVocabUnknownCount] = useState(0);

  // 試験スケジュール用 state
  const [examEvents, setExamEvents] = useState<ExamEvent[]>(DEFAULT_EXAM_SCHEDULE);
  const [scheduleTab, setScheduleTab] = useState<'calendar' | 'list'>('list');
  const [calendarMonth, setCalendarMonth] = useState(() => {
    const now = new Date();
    return { year: now.getFullYear(), month: now.getMonth() };
  });
  const [editingEvent, setEditingEvent] = useState<ExamEvent | null>(null);
  const [isAddingEvent, setIsAddingEvent] = useState(false);
  const [notifPermissionGranted, setNotifPermissionGranted] = useState<boolean | null>(null);

  // ── 日別学習ログ state ────────────────────────
  const [dailyLog, setDailyLog] = useState<{ [date: string]: number }>({});

  const initialStats: StatsType = {
    '経済学・経済政策': { total: 0, correct: 0 },
    '財務・会計': { total: 0, correct: 0 },
    '企業経営理論': { total: 0, correct: 0 },
    '運営管理': { total: 0, correct: 0 },
    '経営法務': { total: 0, correct: 0 },
    '経営情報システム': { total: 0, correct: 0 },
    '中小企業経営・中小企業政策': { total: 0, correct: 0 },
  };

  // ── 年度一覧：モジュールレベルで一度だけ計算済みの定数を使う ──
  const availableYears = AVAILABLE_YEARS;

  // ── 全問題に対する累計進捗率（＝カバレッジ：一度でも解答した問題の割合。ホームタブ・進捗率タブ・
  //    結果画面で共通利用）──
  // ★ 過去問（VALID_QUESTIONS）だけでなく補充問題（AI2026）も含めた練習問題プール全体
  //   （STANDALONE_QUESTIONS）を母数にする。過去問学習モード（年度別）の年度集計は
  //   引き続きVALID_QUESTIONSのみを対象とするため、ここを変更しても年度別モードには影響しない。
  const TOTAL_PRACTICE_QUESTIONS = STANDALONE_QUESTIONS.length;
  const overallProgressRate = TOTAL_PRACTICE_QUESTIONS > 0
    ? Math.round((answeredQuestionIds.size / TOTAL_PRACTICE_QUESTIONS) * 100)
    : 0;

  // ── 5段階の習熟度集計（未学習/初級/中級/上級/マスター）──
  // wrongIds は「streak が MASTERY_STREAK_TARGET 未満」の問題と同義になっているため、
  // wrongIds に入っていない時点で streak は必ず MASTERY_STREAK_TARGET(2) 以上。
  const masteryBuckets: MasteryBuckets = useMemo(() => {
    let unlearned = 0, beginner = 0, intermediate = 0, advanced = 0, master = 0;
    STANDALONE_QUESTIONS.forEach((q: any) => {
      if (!q.id || !answeredQuestionIds.has(q.id)) { unlearned++; return; }
      if (wrongIds.has(q.id)) { beginner++; return; }
      const streak = mastery[q.id] ?? 0;
      if (streak >= 4) master++;
      else if (streak === 3) advanced++;
      else intermediate++;
    });
    return { unlearned, beginner, intermediate, advanced, master };
  }, [answeredQuestionIds, wrongIds, mastery]);

  // ── 習得率：mastery（連続正解数）が2以上に達した問題の割合をメインの進捗指標とする ──
  // 「間違えても解いた」だけでは進捗にカウントしない、という合意済みの設計方針に基づく。
  const masteryRate = TOTAL_PRACTICE_QUESTIONS > 0
    ? Math.round(((masteryBuckets.intermediate + masteryBuckets.advanced + masteryBuckets.master) / TOTAL_PRACTICE_QUESTIONS) * 100)
    : 0;
  const masteredCount = masteryBuckets.intermediate + masteryBuckets.advanced + masteryBuckets.master;

  // ── 初期化 ─────────────────────────────────
  useEffect(() => {
    const init = async () => {
      try {
        const savedStats = await loadSubjectStats();
        setStats({ ...initialStats, ...savedStats });
      } catch (e) {
        console.error('stats load error:', e);
        showStorageErrorToast('学習履歴の読み込みに失敗しました');
      }

      try {
        const keys = [
          WRONG_ANSWERS_KEY,
          ANSWERED_QUESTION_IDS_KEY,
          MASTERY_KEY,
          WRONG_WORDS_KEY,
          EXAM_SCHEDULE_KEY,
          DAILY_LOG_KEY,
          SETTINGS_KEY,
          TODAY_FIVE_KEY,
        ];
        const pairs = await AsyncStorage.multiGet(keys);
        const map = new Map(pairs);

        const wrongRaw = map.get(WRONG_ANSWERS_KEY);
        if (wrongRaw) setWrongIds(new Set(JSON.parse(wrongRaw)));

        const answeredRaw = map.get(ANSWERED_QUESTION_IDS_KEY);
        if (answeredRaw) setAnsweredQuestionIds(new Set(JSON.parse(answeredRaw)));

        const masteryRaw = map.get(MASTERY_KEY);
        if (masteryRaw) setMastery(JSON.parse(masteryRaw));

        const wrongWordsRaw = map.get(WRONG_WORDS_KEY);
        if (wrongWordsRaw) setWrongWordIds(new Set(JSON.parse(wrongWordsRaw)));

        const scheduleRaw = map.get(EXAM_SCHEDULE_KEY);
        if (scheduleRaw) {
          setExamEvents(JSON.parse(scheduleRaw));
        } else {
          // 初回起動時のみ、デフォルト日程を書き込む
          try {
            await AsyncStorage.setItem(EXAM_SCHEDULE_KEY, JSON.stringify(DEFAULT_EXAM_SCHEDULE));
          } catch (e) {
            console.error('exam schedule initial save error:', e);
            showStorageErrorToast('試験スケジュールの初期化に失敗しました');
          }
        }

        const dailyLogRaw = map.get(DAILY_LOG_KEY);
        if (dailyLogRaw) setDailyLog(JSON.parse(dailyLogRaw));

        // ── 「今日の5問」：当日分の記録を復元する。日付が変わっていれば
        //    古い記録なので破棄し、次に開始した時点で新しく生成し直す。
        const todayFiveRaw = map.get(TODAY_FIVE_KEY);
        if (todayFiveRaw) {
          const parsedRecord: TodayFiveRecord = JSON.parse(todayFiveRaw);
          if (parsedRecord.date === getTodayStr()) setTodayFiveRecord(parsedRecord);
        }

        let parsedAutoShowExplanation = autoShowExplanation;
        let parsedReminderEnabled = false;
        let parsedReminderHour = 20;
        let parsedReminderMinute = 0;
        let parsedReminderNotifId: string | null = null;
        // ── 復習リマインダー(忘却曲線)設定のデフォルト値 ──
        let parsedReviewEnabled = false;
        let parsedReviewHour = 9;
        let parsedReviewMinute = 0;
        let parsedReviewNotifId: string | null = null;

        const settingsRaw = map.get(SETTINGS_KEY);
        if (settingsRaw) {
          const parsed = JSON.parse(settingsRaw);
          if (typeof parsed.autoShowExplanation === 'boolean') {
            parsedAutoShowExplanation = parsed.autoShowExplanation;
            setAutoShowExplanation(parsed.autoShowExplanation);
          }
          if (typeof parsed.dailyReminderEnabled === 'boolean') parsedReminderEnabled = parsed.dailyReminderEnabled;
          if (typeof parsed.dailyReminderHour === 'number') parsedReminderHour = parsed.dailyReminderHour;
          if (typeof parsed.dailyReminderMinute === 'number') parsedReminderMinute = parsed.dailyReminderMinute;
          if (typeof parsed.dailyReminderNotificationId === 'string') parsedReminderNotifId = parsed.dailyReminderNotificationId;
          if (typeof parsed.reviewRemindersEnabled === 'boolean') parsedReviewEnabled = parsed.reviewRemindersEnabled;
          if (typeof parsed.reviewReminderHour === 'number') parsedReviewHour = parsed.reviewReminderHour;
          if (typeof parsed.reviewReminderMinute === 'number') parsedReviewMinute = parsed.reviewReminderMinute;
          if (typeof parsed.reviewReminderNotificationId === 'string') parsedReviewNotifId = parsed.reviewReminderNotificationId;
          if (parsed.todayFiveCount === 5 || parsed.todayFiveCount === 10) setTodayFiveCount(parsed.todayFiveCount);
          if (isQuizCount(parsed.quizCount)) setQuizCount(parsed.quizCount);
        }
        setDailyReminderEnabled(parsedReminderEnabled);
        setDailyReminderHour(parsedReminderHour);
        setDailyReminderMinute(parsedReminderMinute);
        setDailyReminderNotificationId(parsedReminderNotifId);
        setReviewRemindersEnabled(parsedReviewEnabled);
        setReviewReminderHour(parsedReviewHour);
        setReviewReminderMinute(parsedReviewMinute);
        setReviewReminderNotificationId(parsedReviewNotifId);

        // ── 起動時に一度、期限到来分のスケジュールを進めておく(bookkeeping)。
        //    通知が有効な場合は、最新の件数で集約通知を再スケジュールする。
        try {
          await pruneAndGetDueQuestionIds();
          if (parsedReviewEnabled) {
            const { status: reviewStatus } = await Notifications.getPermissionsAsync();
            if (reviewStatus === 'granted') {
              if (parsedReviewNotifId) { try { await Notifications.cancelScheduledNotificationAsync(parsedReviewNotifId); } catch {} }
              const dueCount = await getUpcomingDueCount();
              if (dueCount > 0) {
                const newReviewId = await Notifications.scheduleNotificationAsync({
                  content: {
                    title: '⏰ 復習のタイミングです',
                    body: `本日は${dueCount}問が復習のタイミングです。忘れないうちに解いておきましょう。`,
                    sound: true,
                    data: { type: 'reviewDigest' },
                    ...(Platform.OS === 'android' ? { channelId: 'default' } : {}),
                  },
                  trigger: {
                    type: Notifications.SchedulableTriggerInputTypes.DAILY,
                    hour: parsedReviewHour,
                    minute: parsedReviewMinute,
                  },
                });
                setReviewReminderNotificationId(newReviewId);
                await persistSettings({
                  autoShowExplanation: parsedAutoShowExplanation,
                  dailyReminderEnabled: parsedReminderEnabled,
                  dailyReminderHour: parsedReminderHour, dailyReminderMinute: parsedReminderMinute,
                  dailyReminderNotificationId: parsedReminderNotifId,
                  reviewRemindersEnabled: parsedReviewEnabled,
                  reviewReminderHour: parsedReviewHour, reviewReminderMinute: parsedReviewMinute,
                  reviewReminderNotificationId: newReviewId,
                });
              } else {
                // ★修正: dueCountが0の場合もsetStateだけでなくpersistSettingsを
                //   呼び、キャンセル済み(無効)になったreviewReminderNotificationIdを
                //   ストレージ上からもnullにクリアしておく(整合性のため)。
                setReviewReminderNotificationId(null);
                await persistSettings({ reviewReminderNotificationId: null });
              }
            }
          }
        } catch (e) { console.error('review reminder init error:', e); }

        // 通知許可があり、かつ設定上はONなのにOS側に予定がない場合
        // （再インストール直後・スケジュール失敗など）は再登録しておく。
        try {
          const { status } = await Notifications.getPermissionsAsync();
          setNotifPermissionGranted(status === 'granted');

          if (parsedReminderEnabled && status === 'granted') {
            const scheduled = await Notifications.getAllScheduledNotificationsAsync();
            const stillScheduled = parsedReminderNotifId
              ? scheduled.some((n) => n.identifier === parsedReminderNotifId)
              : false;
            if (!stillScheduled) {
              const newId = await scheduleDailyReminderNotification(parsedReminderHour, parsedReminderMinute);
              setDailyReminderNotificationId(newId);
              await persistSettings({
                autoShowExplanation: parsedAutoShowExplanation, dailyReminderEnabled: parsedReminderEnabled,
                dailyReminderHour: parsedReminderHour, dailyReminderMinute: parsedReminderMinute,
                dailyReminderNotificationId: newId,
              });
            }
          }
        } catch (e) { console.error('notification permission check error:', e); }

        // ── ランキング：匿名deviceIdの生成/復元とニックネームの復元。
        //    サーバーへの通信はここでは行わない（ランキング画面を開いたときのみ通信する）──
        try {
          const [id, nickname] = await Promise.all([getOrCreateDeviceId(), loadNickname()]);
          setRankingDeviceId(id);
          setRankingNickname(nickname);
        } catch (e) { console.error('ranking init error:', e); }
      } catch (e) {
        console.error('bulk storage load error:', e);
        showStorageErrorToast('学習データの読み込みに失敗しました');
      }
    };
    init();
  }, []);

  // 「今日の5問」通知をタップしたときの遷移。
  // アプリがバックグラウンド/起動中にタップした場合はこのリスナーで検知し、
  // 通知タップでアプリがコールドスタートした場合は getLastNotificationResponseAsync で拾う。
  useEffect(() => {
    const handleResponse = (response: Notifications.NotificationResponse | null) => {
      const data = response?.notification.request.content.data as { type?: string } | undefined;
      if (data?.type === 'daily5') {
        startTodayFive();
      } else if (data?.type === 'reviewDigest') {
        // 復習リマインダー通知のタップ：要復習リスト(wrongIds)の問題をまとめて出題する。
        // 忘却曲線スケジュールの対象はmastery未達の問題＝wrongIdsとほぼ同一集合のため、
        // 専用の抽出ロジックを新設せず既存のstartReviewWrongに合流させている。
        startReviewWrong();
      }
    };

    const sub = Notifications.addNotificationResponseReceivedListener(handleResponse);
    Notifications.getLastNotificationResponseAsync().then(handleResponse);

    return () => sub.remove();
  }, []);

  // ── 復習リマインダー：アプリがフォアグラウンドに復帰するたびに、
  //    期限到来分のスケジュールを進め(pruneAndGetDueQuestionIds)、
  //    有効なら最新の件数で集約通知を再スケジュールする。
  //    (ローカル通知は予約時点の本文が固定されるため、開くたびに
  //     作り直すことで「本日はX問」の数字が実態に近い状態を保つ) ──
  useEffect(() => {
    const refreshReviewDigest = async () => {
      try {
        await pruneAndGetDueQuestionIds();
        if (!reviewRemindersEnabled) return;
        const { status } = await Notifications.getPermissionsAsync();
        if (status !== 'granted') return;
        if (reviewReminderNotificationId) {
          try { await Notifications.cancelScheduledNotificationAsync(reviewReminderNotificationId); } catch {}
        }
        const dueCount = await getUpcomingDueCount();
        if (dueCount <= 0) {
          setReviewReminderNotificationId(null);
          await persistSettings({ reviewReminderNotificationId: null });
          return;
        }
        const newId = await Notifications.scheduleNotificationAsync({
          content: {
            title: '⏰ 復習のタイミングです',
            body: `本日は${dueCount}問が復習のタイミングです。忘れないうちに解いておきましょう。`,
            sound: true,
            data: { type: 'reviewDigest' },
            ...(Platform.OS === 'android' ? { channelId: 'default' } : {}),
          },
          trigger: {
            type: Notifications.SchedulableTriggerInputTypes.DAILY,
            hour: reviewReminderHour,
            minute: reviewReminderMinute,
          },
        });
        setReviewReminderNotificationId(newId);
        await persistSettings({ reviewReminderNotificationId: newId });
      } catch (e) { console.error('review digest refresh error:', e); }
    };

    const sub = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'active') refreshReviewDigest();
    });
    return () => sub.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reviewRemindersEnabled, reviewReminderHour, reviewReminderMinute, reviewReminderNotificationId]);

  // ── 弱点診断の可視化：設定タブを開くたびに「復習待ちリスト」の件数を取り直す。
  //    handleAnswer側でリアルタイムに更新してもよいが、頻繁な更新は不要な値
  //    (参考表示のみ)なので、負荷を抑えるためタブ表示のタイミングに限定している。──
  useEffect(() => {
    if (mainTab !== 'settings') return;
    getScheduledReviewCount().then(setScheduledReviewCount).catch(() => {});
  }, [mainTab]);

  // 起動画面：アニメーション（YarikomiSplash）が完了したらonFinishが呼ばれ、
  // ホーム（ハブ画面）へ遷移する（旧・固定1.5秒タイマーは廃止）。

  // ── 各種保存ヘルパー：失敗時はコンソールログに加え、トーストでユーザーにも通知する ──
  const saveWrongIds = async (ids: Set<string>) => {
    try {
      await AsyncStorage.setItem(WRONG_ANSWERS_KEY, JSON.stringify([...ids]));
    } catch (e) {
      console.error('wrong answers save error:', e);
      showStorageErrorToast('間違いリストの保存に失敗しました');
    }
  };

  // ── 進捗率用データの保存ヘルパー ───────────────
  const saveAnsweredQuestionIds = async (ids: Set<string>) => {
    try {
      await AsyncStorage.setItem(ANSWERED_QUESTION_IDS_KEY, JSON.stringify([...ids]));
    } catch (e) {
      console.error('answered question ids save error:', e);
      showStorageErrorToast('進捗データの保存に失敗しました');
    }
  };

  // ── 習熟度データの保存ヘルパー ─────────────────
  const saveMastery = async (m: { [id: string]: number }) => {
    try {
      await AsyncStorage.setItem(MASTERY_KEY, JSON.stringify(m));
    } catch (e) {
      console.error('mastery save error:', e);
      showStorageErrorToast('習熟度データの保存に失敗しました');
    }
  };

  const saveWrongWordIds = async (ids: Set<string>) => {
    try {
      await AsyncStorage.setItem(WRONG_WORDS_KEY, JSON.stringify([...ids]));
    } catch (e) {
      console.error('wrong words save error:', e);
      showStorageErrorToast('単語の復習リストの保存に失敗しました');
    }
  };

  // ── 日別ログ保存ヘルパー ─────────────────────
  const saveDailyLog = async (log: { [date: string]: number }) => {
    try {
      await AsyncStorage.setItem(DAILY_LOG_KEY, JSON.stringify(log));
    } catch (e) {
      console.error('daily log save error:', e);
      showStorageErrorToast('学習ログの保存に失敗しました');
    }
  };

  // ── 「今日の5問」：当日分の出題記録を保存するヘルパー ──
  const saveTodayFiveRecord = async (record: TodayFiveRecord) => {
    try {
      await AsyncStorage.setItem(TODAY_FIVE_KEY, JSON.stringify(record));
    } catch (e) {
      console.error('today five record save error:', e);
      showStorageErrorToast('「今日の5問」の記録の保存に失敗しました');
    }
  };

  // ── 設定保存ヘルパー ─────────────────────────
  // 設定は1つのJSONにまとめて保存する。overridesで渡した項目だけを上書きし、
  // それ以外は現在のstateの値をそのまま使う。
  // ── 設定の永続化 ──────────────────────────────────────────
  // ★修正(stale closure対策): 以前はここでコンポーネントのstate
  //   (dailyReminderEnabled等)を直接クロージャで参照してマージしていたが、
  //   復習リマインダーのAppState監視useEffect(依存配列が復習系の値のみ)
  //   の中からこの関数が呼ばれる場合、その関数自体が「復習系の値が
  //   最後に変わった時点」のstateを固定的に参照してしまう。その間に
  //   ユーザーが「今日の5問」通知の時刻や表示設定を変更していても、
  //   その変更後にアプリをバックグラウンド→フォアグラウンド復帰させると、
  //   復習系のrefreshが古いstateでAsyncStorageを上書きし、
  //   変更が「静かに巻き戻る」不具合があった(アプリ再起動時に発覚)。
  //   対策として、コンポーネントstateではなく、その時点でAsyncStorageに
  //   実際に保存されている最新の値を読み直してからoverridesをマージする
  //   (read-modify-write)方式に変更。呼び出し元のクロージャがどれだけ
  //   古くても、変更していないフィールドは常にディスク上の最新値が
  //   優先されるため、上記の巻き戻りが原理的に起こらなくなる。
  const persistSettings = async (overrides: Partial<{
    autoShowExplanation: boolean;
    dailyReminderEnabled: boolean;
    dailyReminderHour: number;
    dailyReminderMinute: number;
    dailyReminderNotificationId: string | null;
    reviewRemindersEnabled: boolean;
    reviewReminderHour: number;
    reviewReminderMinute: number;
    reviewReminderNotificationId: string | null;
    todayFiveCount: 5 | 10;
    quizCount: QuizCount;
  }>) => {
    try {
      const existingRaw = await AsyncStorage.getItem(SETTINGS_KEY);
      const existing = existingRaw != null ? JSON.parse(existingRaw) : {};
      const merged = {
        // フォールバック(ディスクに何も無い初回のみ使われる想定)
        autoShowExplanation,
        dailyReminderEnabled,
        dailyReminderHour,
        dailyReminderMinute,
        dailyReminderNotificationId,
        reviewRemindersEnabled,
        reviewReminderHour,
        reviewReminderMinute,
        reviewReminderNotificationId,
        todayFiveCount,
        quizCount,
        // ディスク上の最新値(古いクロージャのstateより常に優先)
        ...existing,
        // 今回明示的に変更したいフィールド(最優先)
        ...overrides,
      };
      await AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify(merged));
    } catch (e) {
      console.error('settings save error:', e);
      showStorageErrorToast('設定の保存に失敗しました');
    }
  };

  const updateAutoShowExplanation = async (value: boolean) => {
    setAutoShowExplanation(value);
    await persistSettings({ autoShowExplanation: value });
  };

  // 「今日の5問」の出題数（5問/10問）を変更する。
  // 当日すでに出題セットを生成済みの場合は件数だけ変えても混乱するため、
  // 反映は翌日以降の新規生成分からになる(既存の当日分はそのまま)。
  const updateTodayFiveCount = async (value: 5 | 10) => {
    setTodayFiveCount(value);
    await persistSettings({ todayFiveCount: value });
  };

  // 出題数（5/10/20/30/50問/全問）を変更して保存する。練習・トピック別・過去問で共通。
  const updateQuizCount = async (value: QuizCount) => {
    setQuizCount(value);
    await persistSettings({ quizCount: value });
  };

  // 試験スケジュール：通知関連ヘルパー
  const ensureNotificationPermission = async (): Promise<boolean> => {
    try {
      const current = await Notifications.getPermissionsAsync();
      if (current.status === 'granted') { setNotifPermissionGranted(true); return true; }
      const req = await Notifications.requestPermissionsAsync();
      const granted = req.status === 'granted';
      setNotifPermissionGranted(granted);
      if (!granted) {
        Alert.alert('通知が許可されていません', '端末の設定アプリから通知を許可してください。');
      }
      return granted;
    } catch (e) {
      console.error('notification permission request error:', e);
      return false;
    }
  };

  const scheduleEventNotification = async (event: ExamEvent): Promise<string | null> => {
    if (!event.notifyEnabled) return null;
    const granted = await ensureNotificationPermission();
    if (!granted) return null;

    const target = new Date(`${event.date}T09:00:00`);
    target.setDate(target.getDate() - event.notifyDaysBefore);
    if (target.getTime() <= Date.now()) return null;

    try {
      const id = await Notifications.scheduleNotificationAsync({
        content: {
          title: `🗓️ ${event.title}`,
          body: event.notifyDaysBefore > 0
            ? `あと${event.notifyDaysBefore}日（${event.date}）です。`
            : `本日（${event.date}）です。`,
          sound: true,
          ...(Platform.OS === 'android' ? { channelId: 'default' } : {}),
        },
        trigger: {
          type: Notifications.SchedulableTriggerInputTypes.DATE,
          date: target,
        },
      });
      return id;
    } catch (e) {
      console.error('schedule notification error:', e);
      return null;
    }
  };

  const cancelEventNotification = async (notificationId?: string | null) => {
    if (!notificationId) return;
    try { await Notifications.cancelScheduledNotificationAsync(notificationId); }
    catch (e) { console.error('cancel notification error:', e); }
  };

  // ── 毎日「今日の5問」リマインダー通知 ──────────────────────
  // 毎日指定した時刻に繰り返し発火するローカル通知。タップすると
  // data.type === 'daily5' を目印に、その場で5問の練習を開始する
  // （下の addNotificationResponseReceivedListener を参照）。
  const scheduleDailyReminderNotification = async (hour: number, minute: number): Promise<string | null> => {
    try {
      const id = await Notifications.scheduleNotificationAsync({
        content: {
          title: '📝 今日の5問',
          body: 'サクッと5問だけ解いて、今日の学習を積み重ねましょう。',
          sound: true,
          data: { type: 'daily5' },
          ...(Platform.OS === 'android' ? { channelId: 'default' } : {}),
        },
        trigger: {
          type: Notifications.SchedulableTriggerInputTypes.DAILY,
          hour,
          minute,
        },
      });
      return id;
    } catch (e) {
      console.error('schedule daily reminder error:', e);
      return null;
    }
  };

  const updateDailyReminderEnabled = async (value: boolean) => {
    if (value) {
      const granted = await ensureNotificationPermission();
      if (!granted) return;
      if (dailyReminderNotificationId) await cancelEventNotification(dailyReminderNotificationId);
      const id = await scheduleDailyReminderNotification(dailyReminderHour, dailyReminderMinute);
      setDailyReminderEnabled(true);
      setDailyReminderNotificationId(id);
      await persistSettings({ dailyReminderEnabled: true, dailyReminderNotificationId: id });
    } else {
      if (dailyReminderNotificationId) await cancelEventNotification(dailyReminderNotificationId);
      setDailyReminderEnabled(false);
      setDailyReminderNotificationId(null);
      await persistSettings({ dailyReminderEnabled: false, dailyReminderNotificationId: null });
    }
  };

  const updateDailyReminderTime = async (hour: number, minute: number) => {
    setDailyReminderHour(hour);
    setDailyReminderMinute(minute);
    if (dailyReminderEnabled) {
      if (dailyReminderNotificationId) await cancelEventNotification(dailyReminderNotificationId);
      const id = await scheduleDailyReminderNotification(hour, minute);
      setDailyReminderNotificationId(id);
      await persistSettings({ dailyReminderHour: hour, dailyReminderMinute: minute, dailyReminderNotificationId: id });
    } else {
      await persistSettings({ dailyReminderHour: hour, dailyReminderMinute: minute });
    }
  };

  // ── 復習リマインダー(忘却曲線)：ON/OFF切り替え ──────────────
  const updateReviewRemindersEnabled = async (value: boolean) => {
    if (value) {
      const granted = await ensureNotificationPermission();
      if (!granted) return;
      if (reviewReminderNotificationId) await cancelEventNotification(reviewReminderNotificationId);
      await pruneAndGetDueQuestionIds();
      const dueCount = await getUpcomingDueCount();
      let id: string | null = null;
      if (dueCount > 0) {
        id = await Notifications.scheduleNotificationAsync({
          content: {
            title: '⏰ 復習のタイミングです',
            body: `本日は${dueCount}問が復習のタイミングです。忘れないうちに解いておきましょう。`,
            sound: true,
            data: { type: 'reviewDigest' },
            ...(Platform.OS === 'android' ? { channelId: 'default' } : {}),
          },
          trigger: {
            type: Notifications.SchedulableTriggerInputTypes.DAILY,
            hour: reviewReminderHour,
            minute: reviewReminderMinute,
          },
        });
      }
      setReviewRemindersEnabled(true);
      setReviewReminderNotificationId(id);
      await persistSettings({ reviewRemindersEnabled: true, reviewReminderNotificationId: id });
    } else {
      if (reviewReminderNotificationId) await cancelEventNotification(reviewReminderNotificationId);
      setReviewRemindersEnabled(false);
      setReviewReminderNotificationId(null);
      await persistSettings({ reviewRemindersEnabled: false, reviewReminderNotificationId: null });
    }
  };

  // ── 復習リマインダーの通知時刻を変更 ──────────────────────
  const updateReviewReminderTime = async (hour: number, minute: number) => {
    setReviewReminderHour(hour);
    setReviewReminderMinute(minute);
    if (reviewRemindersEnabled) {
      if (reviewReminderNotificationId) await cancelEventNotification(reviewReminderNotificationId);
      const dueCount = await getUpcomingDueCount();
      let id: string | null = null;
      if (dueCount > 0) {
        id = await Notifications.scheduleNotificationAsync({
          content: {
            title: '⏰ 復習のタイミングです',
            body: `本日は${dueCount}問が復習のタイミングです。忘れないうちに解いておきましょう。`,
            sound: true,
            data: { type: 'reviewDigest' },
            ...(Platform.OS === 'android' ? { channelId: 'default' } : {}),
          },
          trigger: {
            type: Notifications.SchedulableTriggerInputTypes.DAILY,
            hour,
            minute,
          },
        });
      }
      setReviewReminderNotificationId(id);
      await persistSettings({ reviewReminderHour: hour, reviewReminderMinute: minute, reviewReminderNotificationId: id });
    } else {
      await persistSettings({ reviewReminderHour: hour, reviewReminderMinute: minute });
    }
  };

  // ── ランキング：画面を開いたときに「自分のスコアを送信→最新ランキングを取得」する。
  //    毎回の解答のたびに送信すると通信が増えすぎるため、ランキング画面を
  //    開いたタイミングに限定して同期する設計にしている。 ──
  const refreshRanking = async () => {
    setRankingLoading(true);
    setRankingError('');
    try {
      const weeklyCount = computeWeeklyAnsweredCount(dailyLog);
      if (RANKING_ENABLED && rankingDeviceId) {
        const submitResult = await submitScore(rankingDeviceId, rankingNickname, weeklyCount);
        if (!submitResult.ok) {
          setRankingError(submitResult.error);
          setRankingLoading(false);
          return;
        }
      }
      const result = await fetchLeaderboard();
      if (result.ok) {
        setLeaderboard(result.data.leaderboard);
        setLeaderboardTotal(result.data.totalParticipants);
      } else {
        setRankingError(result.error);
      }
    } catch (e) {
      setRankingError('ランキングの更新に失敗しました');
    } finally {
      setRankingLoading(false);
    }
  };

  const updateRankingNickname = async (value: string) => {
    setRankingNickname(value);
    await saveNickname(value);
  };

  const saveExamEvents = async (events: ExamEvent[]) => {
    try {
      await AsyncStorage.setItem(EXAM_SCHEDULE_KEY, JSON.stringify(events));
    } catch (e) {
      console.error('exam schedule save error:', e);
      showStorageErrorToast('試験スケジュールの保存に失敗しました');
    }
  };

  const upsertExamEvent = async (event: ExamEvent, isNew: boolean) => {
    const prev = examEvents.find(e => e.id === event.id);
    if (prev?.notificationId) await cancelEventNotification(prev.notificationId);

    const notificationId = await scheduleEventNotification(event);
    const finalEvent: ExamEvent = { ...event, notificationId };

    const next = isNew
      ? [...examEvents, finalEvent]
      : examEvents.map(e => (e.id === finalEvent.id ? finalEvent : e));
    const sorted = [...next].sort((a, b) => a.date.localeCompare(b.date));
    setExamEvents(sorted);
    await saveExamEvents(sorted);
  };

  const deleteExamEvent = async (id: string) => {
    const target = examEvents.find(e => e.id === id);
    if (target?.notificationId) await cancelEventNotification(target.notificationId);
    const next = examEvents.filter(e => e.id !== id);
    setExamEvents(next);
    await saveExamEvents(next);
  };

  const resetExamScheduleToDefault = async () => {
    for (const e of examEvents) { if (e.notificationId) await cancelEventNotification(e.notificationId); }
    setExamEvents(DEFAULT_EXAM_SCHEDULE);
    await saveExamEvents(DEFAULT_EXAM_SCHEDULE);
    Alert.alert('完了', '試験スケジュールを初期状態（予定なし）に戻しました。');
  };

  // ── ★修正：デフォルト日程・初回起動時の予定は notifyEnabled: true が
  //    セットされているだけで、実際にはOSへ通知がスケジュールされていない
  //    （scheduleEventNotification は upsertExamEvent 経由でしか呼ばれない）。
  //    そのため、画面上は🔔「ON」と表示されるのに実際には一切通知が届かない、
  //    という不具合があった。ユーザーが「試験スケジュール」タブを開いた
  //    タイミング（＝通知の必要性が実際に意識される場面）で、通知が
  //    未スケジュールなままの予定（notifyEnabled: true かつ notificationId
  //    未設定）だけをまとめてスケジュールする。通知許可のダイアログも
  //    このタイミングで初めて表示される（アプリ起動直後にいきなり
  //    許可を求めることを避けるため）。
  //    通知対象日時が既に過ぎている予定は scheduleEventNotification が
  //    null を返すため、無駄な許可チェックを避けるためここで事前に除外する。
  useEffect(() => {
    if (progressSubTab !== 'schedule') return;
    const now = Date.now();
    const pending = examEvents.filter((e) => {
      if (!e.notifyEnabled || e.notificationId) return false;
      const target = new Date(`${e.date}T09:00:00`);
      target.setDate(target.getDate() - e.notifyDaysBefore);
      return target.getTime() > now;
    });
    if (pending.length === 0) return;

    (async () => {
      let changed = false;
      const updated = [...examEvents];
      for (const e of pending) {
        const notificationId = await scheduleEventNotification(e);
        if (notificationId) {
          changed = true;
          const idx = updated.findIndex((x) => x.id === e.id);
          if (idx !== -1) updated[idx] = { ...updated[idx], notificationId };
        }
      }
      if (changed) {
        const sorted = [...updated].sort((a, b) => a.date.localeCompare(b.date));
        setExamEvents(sorted);
        await saveExamEvents(sorted);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [progressSubTab]);

 const confirmResetExamScheduleToDefault = () => {
  confirmAndRun(
    'デフォルトの日程に戻す',
    '編集・追加した予定はすべて削除され、初期の試験日程に戻ります。この操作は取り消せません。よろしいですか？',
    '戻す',
    resetExamScheduleToDefault
  );
};

const confirmDeleteExamEvent = (id: string, title: string) => {
  confirmAndRun(
    '予定を削除',
    `「${title}」を削除します。この操作は取り消せません。よろしいですか？`,
    '削除する',
    async () => {
      await deleteExamEvent(id);
      setEditingEvent(null);
      setIsAddingEvent(false);
    }
  );
};
  const resetAllStats = async () => {
    try {
      await AsyncStorage.removeItem('@shindanshi_stats');
      await AsyncStorage.removeItem(WRONG_ANSWERS_KEY);
      await AsyncStorage.removeItem(WRONG_WORDS_KEY);
      await AsyncStorage.removeItem(DAILY_LOG_KEY);
      await AsyncStorage.removeItem(ANSWERED_QUESTION_IDS_KEY);
      await AsyncStorage.removeItem(MASTERY_KEY);
      await clearSessionSnapshot();
      setResumeSnapshot(null);
      await resetReviewSchedule();
      setStats(initialStats);
      setWrongIds(new Set());
      setWrongWordIds(new Set());
      setDailyLog({});
      setAnsweredQuestionIds(new Set());
      setMastery({});
      if (reviewReminderNotificationId) await cancelEventNotification(reviewReminderNotificationId);
      setReviewReminderNotificationId(null);
      await persistSettings({ reviewReminderNotificationId: null });
      // ★修正：resetAllStatsは設定画面（mainTab==='settings'）のボタンから呼ばれるため、
      //   タブ切り替えを検知するuseEffectだけに任せると「現在○問が復習待ちリストに
      //   入っています」の表示がリセット後も古い件数のまま残ってしまう。ここで明示的に0へ戻す。
      setScheduledReviewCount(0);
      Alert.alert('完了', '学習履歴と間違いリストをリセットしました！');
    } catch (e) {
      console.error('reset error:', e);
      showStorageErrorToast('学習履歴のリセットに失敗しました');
    }
  };
// ── 確認ダイアログ：Alert.alertはWeb（react-native-web）では
//    ダイアログを描画せず、onPressも呼ばれないため反応がないように見える。
//    Web時はwindow.confirmにフォールバックする。 ──
const confirmAndRun = (
  title: string,
  message: string,
  confirmLabel: string,
  onConfirm: () => void
) => {
  if (Platform.OS === 'web') {
    if (typeof window !== 'undefined' && window.confirm(`${title}\n\n${message}`)) {
      onConfirm();
    }
  } else {
    Alert.alert(title, message, [
      { text: 'キャンセル', style: 'cancel' },
      { text: confirmLabel, style: 'destructive', onPress: onConfirm },
    ]);
  }
};

// ── 情報ダイアログ：確認不要の単純な説明表示用。
//    confirmAndRun同様、Web（react-native-web）ではAlert.alertが描画されないため
//    window.alertにフォールバックする。 ──
const showInfoAlert = (title: string, message: string) => {
  if (Platform.OS === 'web') {
    if (typeof window !== 'undefined') window.alert(`${title}\n\n${message}`);
  } else {
    Alert.alert(title, message);
  }
};
  // ── 学習履歴リセット：確認ダイアログ付きラッパー ─────────────
 const confirmResetAllStats = () => {
  confirmAndRun(
    '学習履歴をリセット',
    'すべての正答率・間違いリスト・習熟度データが削除されます。この操作は取り消せません。よろしいですか？',
    'リセットする',
    resetAllStats
  );
};

  // ── 学習分析（進捗率タブ「学習分析」で使う集計）──
  const analysisSummary = useMemo(() => {
    const totals = Object.values(stats).reduce(
      (a, s) => ({ total: a.total + s.total, correct: a.correct + s.correct }),
      { total: 0, correct: 0 }
    );
    const overallRate = totals.total > 0 ? Math.round((totals.correct / totals.total) * 100) : null;

    const sortedByWeak = [...SUBJECT_META]
      .filter(s => (stats[s.key]?.total || 0) >= 1)
      .sort((a, b) => {
        const ra = getRate(stats[a.key] ?? { total: 0, correct: 0 }) ?? 999;
        const rb = getRate(stats[b.key] ?? { total: 0, correct: 0 }) ?? 999;
        return ra - rb;
      });

    const weakSubs = sortedByWeak.filter(s => {
      const r = getRate(stats[s.key] ?? { total: 0, correct: 0 });
      return r !== null && r < 60;
    });
    const strongSubs = sortedByWeak.filter(s => {
      const r = getRate(stats[s.key] ?? { total: 0, correct: 0 });
      return r !== null && r >= 70;
    });

    const judge = (() => {
      if (overallRate === null) return null;
      if (overallRate >= 70) return { text: `総合 ${overallRate}% — 合格圏内`, sub: '現在の水準を維持しつつ、弱点科目に集中投資しましょう。', color: '#2ecc71' };
      if (overallRate >= 60) return { text: `総合 ${overallRate}% — 合格ラインギリギリ`, sub: '得意科目をさらに伸ばし、苦手科目の底上げを優先してください。', color: '#EF9F27' };
      return { text: `総合 ${overallRate}% — 合格ライン未達`, sub: '各科目60%を目標に、下記の科目から取り組みましょう。', color: '#e74c3c' };
    })();

    return { totals, overallRate, sortedByWeak, weakSubs, strongSubs, judge };
  }, [stats]);

  // ── 試験スケジュール：カレンダー表示用データ ──
  const calendarData = useMemo(() => {
    const monthLabel = `${calendarMonth.year}年${calendarMonth.month + 1}月`;
    const firstDay = new Date(calendarMonth.year, calendarMonth.month, 1);
    const lastDate = new Date(calendarMonth.year, calendarMonth.month + 1, 0).getDate();
    const startWeekday = firstDay.getDay();
    const pad = (n: number) => String(n).padStart(2, '0');

    const eventsByDate: { [date: string]: ExamEvent[] } = {};
    examEvents.forEach(e => {
      eventsByDate[e.date] = eventsByDate[e.date] ?? [];
      eventsByDate[e.date].push(e);
    });

    const cells: (number | null)[] = [
      ...Array(startWeekday).fill(null),
      ...Array.from({ length: lastDate }, (_, i) => i + 1),
    ];
    while (cells.length % 7 !== 0) cells.push(null);

    return { monthLabel, cells, eventsByDate, pad };
  }, [calendarMonth, examEvents]);

  // ── 試験スケジュール：これから／終了した予定のリスト ──
  const scheduleLists = useMemo(() => {
    const upcoming = [...examEvents].filter(e => daysUntil(e.date) >= 0).sort((a, b) => a.date.localeCompare(b.date));
    const past = [...examEvents].filter(e => daysUntil(e.date) < 0).sort((a, b) => a.date.localeCompare(b.date));
    return { upcoming, past };
  }, [examEvents]);

  // ── 連続学習日数 ──
  const streak = useMemo(() => getStreak(dailyLog), [dailyLog]);

  // ── 学習期間の進捗（学習開始〜1次試験まで）──
  // ★修正：過去の試験日程（例：デフォルト日程の1次試験）を拾ってしまうと、
  //    進捗バーが最初から100%表示になってしまうため、nextExamと同様に
  //    daysUntil(e.date) >= 0 で「これから来る試験」だけに絞る。
  const studyProgress = useMemo(() => {
    const firstExam = [...examEvents]
      .filter(e => e.category === '試験' && daysUntil(e.date) >= 0)
      .sort((a, b) => a.date.localeCompare(b.date))[0];
    if (!firstExam) return { pct: null as number | null, firstExam: null as ExamEvent | null };
    const start = new Date(firstExam.date);
    start.setMonth(start.getMonth() - 4);
    const end = new Date(firstExam.date);
    const now = new Date();
    const total = end.getTime() - start.getTime();
    const elapsed = now.getTime() - start.getTime();
    const pct = Math.min(100, Math.max(0, Math.round((elapsed / total) * 100)));
    return { pct, firstExam };
  }, [examEvents]);

  const resetQuestionState = () => {
    setShowExplanation(false);
  };

  // ── 画像タップで拡大表示を開く ─────────────────
  const openZoom = (uris: string[], index: number) => {
    setZoomImages(uris.filter(Boolean).map((uri) => ({ uri })));
    setZoomIndex(index);
    setZoomVisible(true);
  };

  // 現在の出題数設定を、実際に出せる問題数（pool件数）に合わせて確定する。
  const resolveQuizCount = (poolSize: number): number =>
    quizCount === 'all' ? poolSize : Math.min(quizCount, poolSize);

  // 出題数の選択チップ（練習・トピック別・過去問で共通）。poolSize より多い選択肢は出さず、
  // 末尾に「全問（N問）」を出す。
  const renderQuizCountPicker = (poolSize: number, showTotal: boolean = true) => {
    const options = QUIZ_COUNT_OPTIONS.filter((n) => n < poolSize);
    const effective = quizCount === 'all' || quizCount >= poolSize ? 'all' : quizCount;
    return (
      <View style={{ marginBottom: 14 }}>
        <Text style={styles.smartTuneLabel}>出題数</Text>
        <View style={styles.smartChipRow}>
          {options.map((n) => (
            <TouchableOpacity
              key={n}
              style={[styles.smartChip, effective === n && styles.smartChipActive]}
              onPress={() => updateQuizCount(n)}
            >
              <Text style={[styles.smartChipText, effective === n && styles.smartChipTextActive]}>{n}問</Text>
            </TouchableOpacity>
          ))}
          <TouchableOpacity
            style={[styles.smartChip, effective === 'all' && styles.smartChipActive]}
            onPress={() => updateQuizCount('all')}
          >
            <Text style={[styles.smartChipText, effective === 'all' && styles.smartChipTextActive]}>全問{showTotal ? `（${poolSize}問）` : ''}</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  };

  // ── 途中から再開：起動時に、中断中のセッションがあれば読み込む（復元できないものは破棄）──
  useEffect(() => {
    (async () => {
      const snap = await loadSessionSnapshot();
      if (snap && restoreQuestionList(snap, RESUME_QUESTION_LOOKUP)) {
        setResumeSnapshot(snap);
      } else if (snap) {
        await clearSessionSnapshot();
      }
    })();
  }, []);

  // ── 途中から再開：出題中は、回答・移動のたびに状態を保存する。全問終えて結果画面に
  //    進んだら中断データは不要なので消す。ホームに戻っただけなら残す（＝続きから再開できる）。──
  useEffect(() => {
    if (screen === 'question') {
      const snap = buildSnapshot({
        subjectName: selectedSubject, topic: selectedTopic, mode: questionMode,
        questionList, currentIndex, answeredRecords, countedIndices,
        sessionCorrectStreak, streakByIndex,
      });
      if (snap) {
        setResumeSnapshot(snap);
        saveSessionSnapshot(snap);
      }
    } else if (screen === 'result') {
      setResumeSnapshot(null);
      clearSessionSnapshot();
    }
  }, [screen, questionList, currentIndex, answeredRecords, countedIndices, sessionCorrectStreak, streakByIndex]);

  // ── Androidの戻るボタン：画面ごとに「ひとつ前の画面」へ戻す。ホーム／起動画面では
  //    何もせず標準動作（アプリを閉じる）に任せる。出題中はホームに戻るだけで、
  //    上のuseEffectが途中経過を保存しているので「続きから再開」できる。──
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const BACK_TARGET: { [key: string]: string } = {
      practice_mode_select: 'practice_subject_select',
      topic_list: 'topic_select',
      vocab_card: 'vocab',
      vocab_complete: 'vocab',
      past_years: 'past',
      practice_subject_select: 'hub',
      topic_select: 'hub',
      vocab: 'hub',
      past: 'hub',
      howto: 'hub',
      ranking: 'hub',
      question: 'hub',
      result: 'hub',
    };
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      const target = BACK_TARGET[screen];
      if (target) { setScreen(target); return true; }
      return false;
    });
    return () => sub.remove();
  }, [screen]);

  // ── 途中から再開：保存済みのセッションを復元して、続きの問題から始める ──
  const resumeSession = () => {
    const snap = resumeSnapshot;
    const list = snap ? restoreQuestionList(snap, RESUME_QUESTION_LOOKUP) : null;
    if (!snap || !list) {
      setResumeSnapshot(null);
      clearSessionSnapshot();
      Alert.alert('再開できません', '保存されていた問題が見つかりませんでした。');
      return;
    }
    setSelectedSubject(snap.subjectName);
    setSelectedTopic(snap.topic);
    setQuestionMode(snap.mode as QuestionMode);
    setQuestionList(list);
    setCurrentIndex(snap.currentIndex);
    setAnsweredRecords(snap.answered ?? {});
    setCountedIndices(new Set(snap.counted ?? []));
    setSessionCorrectStreak(snap.streak ?? 0);
    setStreakByIndex(snap.streakByIndex ?? {});
    setShowExplanation(!!(snap.answered ?? {})[snap.currentIndex] && autoShowExplanation);
    setShowQuestionImage(true);
    setScreen('question');
  };

  const launchQuestions = (list: any[], subjectName: string, mode: QuestionMode, topic?: string) => {
    setSelectedSubject(subjectName);
    setSelectedTopic(topic ?? null);
    setQuestionMode(mode);
    // AI2026（PR-）の問題だけ選択肢を並べ替える。過去問は変更しない。
    // 出題リスト作成時に1回だけ行うので、同一セッション内の並びは固定される。
    setQuestionList(shuffleQuestionList(list));
    setCurrentIndex(0);
    setAnsweredRecords({});
    setCountedIndices(new Set());
    setSessionCorrectStreak(0);
    setStreakByIndex({});
    resetQuestionState();
    setShowQuestionImage(true);
    setScreen('question');
  };

 const startRandomPractice = () => {
  const list = sampleRandom(STANDALONE_QUESTIONS, resolveQuizCount(STANDALONE_QUESTIONS.length));
  launchQuestions(list, 'ランダム練習問題', 'random');
};

// 「今日の5問」：毎日リマインダー通知のタップ時、および練習画面からの
// 手動スタートの両方で使う。
// ・当日まだ生成していなければ、苦手・未学習の問題を優先する重み付き抽選
//   （おまかせ出題の「弱点重視」と同じロジック）で todayFiveCount 問を選び、
//   日付キー付きで保存する（TodayFiveRecord）。
// ・同じ日に再度呼ばれた場合は、保存済みの同じ問題セットを再開する
//   （1日で出題内容がコロコロ変わらないようにするため）。
const startTodayFive = () => {
  const today = getTodayStr();

  // 今日すでに生成済みなら、同じ問題セット（の続き）を再開する
  if (todayFiveRecord && todayFiveRecord.date === today && todayFiveRecord.questionIds.length > 0) {
    const list = todayFiveRecord.questionIds
      .map((id) => STANDALONE_QUESTIONS.find((q: any) => q.id === id))
      .filter((q): q is any => !!q);
    if (list.length > 0) {
      launchQuestions(list, '今日の5問', 'daily');
      return;
    }
    // 万一データ欠損などでlistが空になった場合は、下の新規生成にフォールバックする
  }

  // 新規生成：苦手・未学習の問題ほど出やすい重み付けで、その日の分を選ぶ
  const pool = STANDALONE_QUESTIONS;
  if (pool.length === 0) return;
  const scores = pool.map((q: any) => computeSmartScore(q, SMART_WEIGHTS.weak));
  const n = Math.min(todayFiveCount, pool.length);
  const list = weightedSampleWithoutReplacement(pool, scores, n);
  const record: TodayFiveRecord = {
    date: today,
    questionIds: list.map((q: any) => q.id).filter(Boolean),
    completed: false,
  };
  setTodayFiveRecord(record);
  saveTodayFiveRecord(record);
  launchQuestions(list, '今日の5問', 'daily');
};

  const startQuizBySubjectAndType = (subjectName: string, type: 'text' | 'material' | 'image' | 'random' | 'weak') => {
    const subjectQuestions = STANDALONE_QUESTIONS.filter((q) => (q as any).subject === subjectName);
    const hasImage = (q: any) => !!q.image || (Array.isArray(q.imagePaths) && q.imagePaths.length > 0) || (Array.isArray(q.options_image) && q.options_image.some((x: any) => !!x));
    let filtered: any[];
    if (type === 'text') filtered = subjectQuestions.filter((q) => !hasImage(q) && !q.material);
    else if (type === 'material') filtered = subjectQuestions.filter((q) => !hasImage(q) && !!q.material);
    else if (type === 'image') filtered = subjectQuestions.filter((q) => hasImage(q));
    else filtered = subjectQuestions; // 'random' と 'weak' はこの科目の全問題が対象（'weak' は下で重み付き抽選する）
    if (filtered.length === 0) {
      const typeLabel = type === 'text' ? '文章問題' : type === 'material' ? '資料読解問題' : type === 'image' ? '図問題' : '問題';
      Alert.alert('データ未登録', `${subjectName}の${typeLabel}が見つかりません。`);
      return;
    }
    const label = type === 'text' ? '文章問題' : type === 'material' ? '資料読解問題' : type === 'image' ? '図問題' : type === 'weak' ? '弱点重点問題' : 'ランダム問題';
    // 「弱点重点」は、Stage 2の「おまかせ出題」と同じスコアリング（苦手優先プリセット）を、
    // この科目内の問題だけに絞って適用し、苦手トピック・間違えた問題ほど出やすくする。
    const selected = type === 'weak'
      ? weightedSampleWithoutReplacement(filtered, filtered.map((q: any) => computeSmartScore(q, SMART_WEIGHTS.weak)), resolveQuizCount(filtered.length))
      : sampleRandom(filtered, resolveQuizCount(filtered.length));
    launchQuestions(selected, subjectName, 'subject', label);
  };

  // 過去問：1科目 × 複数年度。
  // ・全問題を選んだ場合（または選んだ出題数が総数以上）は、年度の新しい順に、各年度の
  //   元の順序のまま出題する（「設問1→設問2」のような連続した設問の文脈を保つため）。
  // ・出題数が総数より少ない場合は無作為に抽出する。この場合は単独で出題しても意味が通る
  //   ように、「（設問2）」以降の問題は抽出対象から除く（練習問題と同じ扱い）。
  const startPastQuiz = (subjectName: string, years: string[]) => {
    const yearSet = new Set(years);
    const pool = VALID_QUESTIONS.filter(q => (q as any).subject === subjectName && yearSet.has((q as any).year));
    if (pool.length === 0) {
      Alert.alert('データ未登録', `${subjectName} の問題データが見つかりません。`);
      return;
    }
    const n = resolveQuizCount(pool.length);
    let list: any[];
    if (n >= pool.length) {
      list = pool;
    } else {
      const standalone = pool.filter(q => !isSubQuestionOnly(q));
      list = sampleRandom(standalone, Math.min(n, standalone.length));
    }
    launchQuestions(list, subjectName, 'past');
  };

const startQuizByTopic = (subjectName: string, topic: string) => {
  // ★修正：トピック別学習画面のボタン一覧（SUBJECT_TOPIC_LIST）は
  // getTopicDisplayLabel(q)（= q.topicCategory、なければ「その他（未分類）」）
  // を元に作られているため、出題側の絞り込みも同じ関数・同じ判定基準に
  // 揃える。以前はここだけ古いフィールド q.topic（1問ごとの個別見出し）と
  // 直接比較していたため、ボタンで選んだトピックとほぼ無関係な問題が
  // 出題される不具合があった。
  const filtered = STANDALONE_QUESTIONS.filter(q =>
    (q as any).subject === subjectName && getTopicDisplayLabel(q as any) === topic
  );
  if (filtered.length === 0) {
    Alert.alert('データ未登録', `${subjectName}「${topic}」の問題データが見つかりません。`);
    return;
  }
  launchQuestions(sampleRandom(filtered, resolveQuizCount(filtered.length)), subjectName, 'topic', topic);
};

  const startReviewWrong = () => {
    if (wrongIds.size === 0) {
      Alert.alert('お知らせ', '要復習の問題はまだありません。\nまずは問題に挑戦してみましょう！');
      return;
    }
    const list = REVIEWABLE_QUESTIONS.filter(q => (q as any).id && wrongIds.has((q as any).id));
    if (list.length === 0) {
      Alert.alert('お知らせ', '復習できる問題が見つかりませんでした。');
      return;
    }
    launchQuestions(sampleRandom(list), '要復習', 'review');
  };

  // ══════════════════════════════════════════════════════════════
  // ── おまかせ出題：スコアリング＋重み付き抽選エンジン ──
  // ══════════════════════════════════════════════════════════════
  // 「内容を調整」パネルで選べる出題数・重視ポイント・対象科目の絞り込み
  const [smartCount, setSmartCount] = useState<10 | 20 | 30>(10);
  const [smartWeightMode, setSmartWeightMode] = useState<'balance' | 'weak' | 'wrong'>('balance');
  // 空Set＝全科目対象。要素が入っている科目は出題対象から除外する。
  const [smartExcludedSubjects, setSmartExcludedSubjects] = useState<Set<string>>(new Set());
  const [smartPanelOpen, setSmartPanelOpen] = useState(false);

  // 重視モードごとの重み係数プリセット
  const SMART_WEIGHTS: { [key: string]: { unanswered: number; wrong: number; weakSubject: number; weakTopic: number; masteredPenalty: number } } = {
    balance:  { unanswered: 3, wrong: 6, weakSubject: 3, weakTopic: 2, masteredPenalty: 5 },
    weak:     { unanswered: 2, wrong: 4, weakSubject: 6, weakTopic: 5, masteredPenalty: 6 },
    wrong:    { unanswered: 1, wrong: 10, weakSubject: 1, weakTopic: 1, masteredPenalty: 4 },
  };

  // 科目×トピックごとの「習得率」を、既存の mastery（連続正解数）・wrongIds・
  // answeredQuestionIds から算出する（新しい永続化ストレージは追加しない設計）。
  // サンプル数が3問未満のトピックは「判断材料が不足」とみなしスコアに影響させない。
  // ★topic_taxonomy_v1で追加された topicCategory（74トピック、moderate granularity）を
  //   優先的に使い、未分類の問題のみ旧 topic フィールドにフォールバックする。
  const topicMasteryRateMemo = useMemo(() => {
    const buckets: { [key: string]: { answered: number; masteredCount: number } } = {};
    VALID_QUESTIONS.forEach((q: any) => {
      const label = q.topicCategory || q.topic;
      if (!q.id || !label || !answeredQuestionIds.has(q.id)) return;
      const key = `${q.subject}__${label}`;
      if (!buckets[key]) buckets[key] = { answered: 0, masteredCount: 0 };
      buckets[key].answered += 1;
      if ((mastery[q.id] ?? 0) >= 2 && !wrongIds.has(q.id)) buckets[key].masteredCount += 1;
    });
    return buckets;
  }, [answeredQuestionIds, mastery, wrongIds]);

  // 1問ごとのスコアを算出する
  const computeSmartScore = (q: any, weights: typeof SMART_WEIGHTS['balance']) => {
    let score = 1; // ベーススコア（どの問題にも最低限の出現機会を残す）
    const answered = q.id && answeredQuestionIds.has(q.id);

    if (!answered) score += weights.unanswered;
    if (q.id && wrongIds.has(q.id)) score += weights.wrong;

    const subjStat = stats[q.subject];
    if (subjStat && subjStat.total >= 5 && subjStat.correct / subjStat.total < 0.6) {
      score += weights.weakSubject;
    }

    const topicLabel = q.topicCategory || q.topic;
    if (topicLabel) {
      const bucket = topicMasteryRateMemo[`${q.subject}__${topicLabel}`];
      if (bucket && bucket.answered >= 3 && bucket.masteredCount / bucket.answered < 0.5) {
        score += weights.weakTopic;
      }
    }

    const streak = q.id ? (mastery[q.id] ?? 0) : 0;
    if (streak >= 3) score -= weights.masteredPenalty;

    return Math.max(score, 0.5); // 0以下にはしない（出現確率をゼロにはしない）
  };

  // 重み付き抽選（非復元）：各要素に random()^(1/weight) のキーを振り、
  // キーが大きい順に上位N件を採用する（A-Res法）。O(n log n)で軽量。
  const weightedSampleWithoutReplacement = (items: any[], weights: number[], n: number) => {
    const keyed = items.map((item, i) => ({
      item,
      key: Math.pow(Math.random(), 1 / weights[i]),
    }));
    keyed.sort((a, b) => b.key - a.key);
    return keyed.slice(0, n).map((k) => k.item);
  };

  // おまかせ出題を開始する
  const startSmartQuiz = () => {
    const weights = SMART_WEIGHTS[smartWeightMode];
    const pool = STANDALONE_QUESTIONS.filter((q: any) =>
      !smartExcludedSubjects.has(q.subject)
    );
    if (pool.length === 0) {
      Alert.alert('お知らせ', '対象科目が選択されていません。少なくとも1科目は含めてください。');
      return;
    }
    const scores = pool.map((q: any) => computeSmartScore(q, weights));
    const n = Math.min(smartCount, pool.length);
    const list = weightedSampleWithoutReplacement(pool, scores, n);
    setSmartPanelOpen(false);
    launchQuestions(list, 'おまかせ出題', 'smart');
  };

 // ── 単語の「関連過去問」を検索するための候補キーワードを生成する ──
 // term（見出し語）は「Ａ・Ｂ（Ｃ）」のような複数概念の複合タイトルになっている
 // ことが多く、この形のまま本文検索してもほぼヒットしない（実データで確認したところ、
 // 全528語中219語＝41.5%が完全一致では0件だった）。そこで、完全一致で見つからない
 // 場合に限り、①括弧書きを除いた部分、②「・」「／」で区切った各語、の順で
 // フォールバック検索する（②まで含めると0件は101語＝19.1%まで減る）。
 const getVocabSearchCandidates = (term: string): string[] => {
   const candidates: string[] = [term];
   const base = term.replace(/[（(][^）)]*[）)]/g, '').trim();
   if (base && base !== term) candidates.push(base);
   base.split(/[・／/]/).map(s => s.trim()).filter(s => s.length >= 2).forEach(seg => {
     if (!candidates.includes(seg)) candidates.push(seg);
   });
   return candidates;
 };

 const startQuizByVocabWord = (word: any) => {
  if (!word || !word.term) return;
  const term = word.term as string;
  let matched: any[] = [];
  for (const candidate of getVocabSearchCandidates(term)) {
    matched = STANDALONE_QUESTIONS.filter(q =>
      (((q as any).question && (q as any).question.includes(candidate)) ||
       ((q as any).explanation && (q as any).explanation.includes(candidate)))
    );
    if (matched.length > 0) break;
  }
  if (matched.length === 0 && word.subjectKey) {
    matched = STANDALONE_QUESTIONS.filter(q =>
      (q as any).subject === word.subjectKey &&
      (q as any).topic === word.topic
    );
  }
    if (matched.length === 0) {
      Alert.alert('関連問題なし', `「${term}」に関連する過去問が見つかりませんでした。`);
      return;
    }
    const list = sampleRandom(matched, 20);
    launchQuestions(list, word.subjectKey ?? selectedSubject, 'vocab_related', term);
  };

  // ── ①answer正規化の反映：selectedIndex === answer / symbolLabels[..] === answer
  //    という二重チェックを、正規化済みの isAnswerCorrect() 一本に統一 ──
  const handleAnswer = async (selectedIndex: number) => {
    if (answeredRecords[currentIndex]) return;
    const currentQ = questionList[currentIndex];
    if (!currentQ) return;
    const correct = isAnswerCorrect(selectedIndex, currentQ.answer);
    setAnsweredRecords(prev => ({ ...prev, [currentIndex]: { selectedIdx: selectedIndex, isCorrect: correct } }));
    // 設定に応じて解説をデフォルトで表示する
    setShowExplanation(autoShowExplanation);

    // ── 統計に使う科目名：画面タイトル（selectedSubject）ではなく、
    //     実際にその問題が属する科目（currentQ.subject）を使う ──
    const actualSubject: string = currentQ.subject ?? selectedSubject;

    // ── ★修正：やり直した場合は、統計・日別ログだけでなく
    //    習熟度（mastery）・要復習リスト（wrongIds）も二重にカウントしない。
    //    以前はこのチェックが下（統計・日別ログの直前）にしかなく、
    //    「間違える→やり直す→正解を見た直後に選び直す」を繰り返すだけで
    //    MASTERY_STREAK_TARGET（連続正解2回）にすぐ到達し、実際には
    //    定着していないのに「マスター」判定になってしまう抜け道があった。
    //    このチェックをmastery更新より前に移動し、そのcurrentIndexでの
    //    最初の回答（＝やり直す前の1回目）だけが記録に反映されるようにする。
    //    やり直し自体（選び直して結果を見ること）は引き続きできるが、
    //    2回目以降の回答は習熟度・要復習リスト・統計のいずれも変化しない。
    if (countedIndices.has(currentIndex)) return;
    setCountedIndices(prev => new Set(prev).add(currentIndex));

    // ── 連続正解カウンタ：最初の回答のみ対象（やり直しの回答は上のreturnで除外済み）。
    //    不正解で0に戻す。過去問・AI2026とも全問題が対象で、問題データには触れない ──
    const nextSessionStreak = correct ? sessionCorrectStreak + 1 : 0;
    setSessionCorrectStreak(nextSessionStreak);
    setStreakByIndex(prev => ({ ...prev, [currentIndex]: nextSessionStreak }));

    // ── 習熟度（連続正解数）を先に計算し、その結果でwrongIdsを更新する。
    //    「間違えた問題」と「正解したがMASTERY_STREAK_TARGET回連続にはまだ
    //    達していない問題」はユーザーから見て同じ「要復習」体験のため、
    //    wrongIds に一本化する（＝「要復習」に入っている＝もう一度解けばよい、
    //    という単純な行動指示に統一。個別の説明文は不要）。
    if (currentQ.id) {
      const prevStreak = mastery[currentQ.id] ?? 0;
      const newStreak = correct ? prevStreak + 1 : 0;
      const newMastery = { ...mastery, [currentQ.id]: newStreak };
      setMastery(newMastery);
      await saveMastery(newMastery);

      const newWrongIds = new Set(wrongIds);
      if (newStreak >= MASTERY_STREAK_TARGET) {
        newWrongIds.delete(currentQ.id);
      } else {
        newWrongIds.add(currentQ.id);
      }
      setWrongIds(newWrongIds);
      await saveWrongIds(newWrongIds);

      // ── 忘却曲線リマインダー：習得済みならスケジュールから外し、
      //    未習得なら「1日後」の段階からやり直す(データ層のみ・通知予約はしない)──
      await recordAnswerForReview(currentQ.id, newStreak >= MASTERY_STREAK_TARGET);
    }

    // ── 日別ログに記録 ────────────────────────
    const todayKey = getTodayStr();
    const newLog = { ...dailyLog, [todayKey]: (dailyLog[todayKey] ?? 0) + 1 };
    setDailyLog(newLog);
    await saveDailyLog(newLog);

    // ── 進捗率用：解いたユニークな問題として記録（カバレッジ・習得率もここから自動計算される）──
    if (currentQ.id && !answeredQuestionIds.has(currentQ.id)) {
      const newAnsweredQuestionIds = new Set(answeredQuestionIds);
      newAnsweredQuestionIds.add(currentQ.id);
      setAnsweredQuestionIds(newAnsweredQuestionIds);
      await saveAnsweredQuestionIds(newAnsweredQuestionIds);
    }

    try {
      await saveQuizResult(actualSubject, correct);
      const newStats = { ...stats };
      newStats[actualSubject] = {
        total: (newStats[actualSubject]?.total ?? 0) + 1,
        correct: correct ? (newStats[actualSubject]?.correct ?? 0) + 1 : (newStats[actualSubject]?.correct ?? 0),
      };
      setStats(newStats);
    } catch (e) {
      console.error('save error:', e);
      showStorageErrorToast('正答率の記録に失敗しました');
    }
  };
  // ── 問題をやり直す（回答を取り消して選択肢を選び直せるようにする）──
  const redoQuestion = () => {
    setAnsweredRecords(prev => {
      const next = { ...prev };
      delete next[currentIndex];
      return next;
    });
    setShowExplanation(false);
  };

  const nextQuestion = () => {
    if (currentIndex < questionList.length - 1) {
      const targetIndex = currentIndex + 1;
      setCurrentIndex(targetIndex);
      setShowExplanation(!!answeredRecords[targetIndex] && autoShowExplanation);
      setShowQuestionImage(true);
    } else {
      // ── 全問終了したら、結果画面を経由する ──
      // 「今日の5問」の場合は、当日分の記録を完了扱いにする
      // （通知は翌日以降も毎日届く設計のため、ここでは通知の取り消しは行わない）
      if (questionMode === 'daily' && todayFiveRecord && todayFiveRecord.date === getTodayStr() && !todayFiveRecord.completed) {
        const updated: TodayFiveRecord = { ...todayFiveRecord, completed: true };
        setTodayFiveRecord(updated);
        saveTodayFiveRecord(updated);
      }
      setScreen('result');
    }
  };

  // ── 前の問題の解答結果を見返す ───────────────
  const prevQuestion = () => {
    if (currentIndex > 0) {
      const targetIndex = currentIndex - 1;
      setCurrentIndex(targetIndex);
      setShowExplanation(!!answeredRecords[targetIndex] && autoShowExplanation);
      setShowQuestionImage(true);
    }
  };

  // 単語学習：ヘルパー
  const launchVocab = (list: any[], subjectName: string, mode: VocabMode) => {
    setVocabSubject(subjectName);
    setVocabMode(mode);
    setVocabList(list);
    setVocabIndex(0);
    setVocabFlipped(false);
    setVocabKnownCount(0);
    setVocabUnknownCount(0);
    setScreen('vocab_card');
  };

  const startVocabRandom = (subjectName: string) => {
    const base = VOCAB_DATA[subjectName] ?? [];
    if (base.length === 0) {
      Alert.alert('準備中', `${subjectName}の単語データはまだ収録されていません。`);
      return;
    }
    launchVocab(sampleRandom(base), subjectName, 'random');
  };

const startVocabReview = () => {
    if (wrongWordIds.size === 0) {
      Alert.alert('お知らせ', '復習が必要な単語はまだありません。\nまずは単語学習に挑戦してみましょう！');
      return;
    }
    const allVocab = Object.values(VOCAB_DATA).flat();
    const list = allVocab.filter((w: any) => w.id && wrongWordIds.has(w.id));
    if (list.length === 0) {
      Alert.alert('お知らせ', '復習できる単語が見つかりませんでした。');
      return;
    }
    launchVocab(sampleRandom(list), '間違い単語復習', 'review');
  };

  const handleVocabJudge = async (known: boolean) => {
    const currentWord = vocabList[vocabIndex];
    if (!currentWord || !currentWord.id) return;
    const newWrongWordIds = new Set(wrongWordIds);
    if (known) {
      newWrongWordIds.delete(currentWord.id);
      setVocabKnownCount(c => c + 1);
    } else {
      newWrongWordIds.add(currentWord.id);
      setVocabUnknownCount(c => c + 1);
    }
    setWrongWordIds(newWrongWordIds);
    await saveWrongWordIds(newWrongWordIds);

    if (vocabIndex < vocabList.length - 1) {
      setVocabIndex(vocabIndex + 1);
      setVocabFlipped(false);
    } else {
      setScreen('vocab_complete');
    }
  };

  // ── ボトムタブバー：選択中のタブだけに色を付ける（単色アイコン）───────────
  const BottomTabBar = () => (
    <View style={styles.bottomTabBar}>
      {MAIN_TABS.map((tab) => {
        const active = mainTab === tab.key;
        return (
          <TouchableOpacity
            key={tab.key}
            style={styles.bottomTabBtn}
            onPress={() => setMainTab(tab.key)}
          >
            <View style={[styles.bottomTabIconWrap, active && styles.bottomTabIconWrapActive]}>
              <MenuIcon name={tab.icon} color={active ? COLORS.primary : COLORS.subtext} size={18} />
            </View>
            <Text style={[styles.bottomTabLabel, active && styles.bottomTabLabelActive]}>{tab.label}</Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );

  // ── Contextに流し込む値をまとめる ──────────────────────
  // 画面を分割した際、各画面コンポーネントは useAppContext() 経由で
  // これらにアクセスする。新しいロジックはここでは何も作っていない。
  const contextValue = {
    // ナビゲーション
    mainTab, setMainTab, progressSubTab, setProgressSubTab,
    screen, setScreen, activeTab, setActiveTab, howtoTab, setHowtoTab,
    selectedSubject, setSelectedSubject, selectedTopic, setSelectedTopic,
    topicSubject, setTopicSubject,

    // 問題関連
    questionMode, questionList, currentIndex, setCurrentIndex,
    answeredRecords, setAnsweredRecords, countedIndices,
    sessionCorrectStreak, streakByIndex,
    showExplanation, setShowExplanation, showQuestionImage, setShowQuestionImage,
    zoomVisible, setZoomVisible, zoomImages, setZoomImages, zoomIndex, setZoomIndex,
    autoShowExplanation, updateAutoShowExplanation,
    selectedYear, setSelectedYear,
    wrongIds, answeredQuestionIds, mastery, stats,

    // 単語学習関連
    vocabSubject, vocabMode, vocabList, vocabIndex, setVocabIndex,
    vocabFlipped, setVocabFlipped, wrongWordIds,
    vocabKnownCount, vocabUnknownCount,

    // 試験スケジュール関連
    examEvents, scheduleTab, setScheduleTab, calendarMonth, setCalendarMonth,
    editingEvent, setEditingEvent, isAddingEvent, setIsAddingEvent,
    notifPermissionGranted, dailyLog,

    // 計算済みの値（useMemoの結果）
    availableYears, overallProgressRate, masteryBuckets, masteryRate, masteredCount,
    analysisSummary, calendarData, scheduleLists, streak, studyProgress,

    // 操作関数
    confirmResetExamScheduleToDefault, confirmResetAllStats,
    resetQuestionState, openZoom, launchQuestions,
    startRandomPractice, startPastQuiz, startQuizByTopic,
    startReviewWrong, startQuizByVocabWord, handleAnswer, redoQuestion,
    nextQuestion, prevQuestion, launchVocab, startVocabRandom,
    startVocabReview, handleVocabJudge,
    upsertExamEvent, confirmDeleteExamEvent,
  };
  // ===== 画面レンダリング =====

  const renderScreen = () => {

  // 起動画面（アニメーション版：約3.7秒後に自動でhubへ遷移）
  if (screen === 'splash') {
    return <YarikomiSplash onFinish={() => setScreen('hub')} />;
  }

  // 試験スケジュール：編集画面
  if (editingEvent) {
    const ev = editingEvent;
    const update = (patch: Partial<ExamEvent>) => setEditingEvent({ ...ev, ...patch });
    const isValid = ev.title.trim().length > 0 && /^\d{4}-\d{2}-\d{2}$/.test(ev.date);

    return (
      <ScrollView style={styles.container} contentContainerStyle={{ paddingBottom: 140 }}>
        <Text style={styles.title}>{isAddingEvent ? '予定を追加' : '予定を編集'}</Text>
        <View style={styles.card}>
          <Text style={styles.formLabel}>タイトル</Text>
          <TextInput style={styles.formInput} value={ev.title} onChangeText={(t) => update({ title: t })} placeholder="例：1次試験（1日目）" placeholderTextColor="#a0aec0" />

          <Text style={[styles.formLabel, { marginTop: 16 }]}>日付（YYYY-MM-DD）</Text>
          <TextInput style={styles.formInput} value={ev.date} onChangeText={(t) => update({ date: t })} placeholder="2026-08-01" placeholderTextColor="#a0aec0" keyboardType="numbers-and-punctuation" />

          <Text style={[styles.formLabel, { marginTop: 16 }]}>分類</Text>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            {(['申込', '試験', '発表'] as const).map(cat => {
              const c = categoryColor(cat);
              const selected = ev.category === cat;
              return (
                <TouchableOpacity key={cat} onPress={() => update({ category: cat })} style={{ flex: 1, paddingVertical: 10, borderRadius: 10, alignItems: 'center', backgroundColor: selected ? c.color : c.bg }}>
                  <Text style={{ fontSize: 13, fontWeight: 'bold', color: selected ? '#fff' : c.color }}>{cat}</Text>
                </TouchableOpacity>
              );
            })}
          </View>

          <Text style={[styles.formLabel, { marginTop: 16 }]}>メモ（任意）</Text>
          <TextInput style={[styles.formInput, { height: 70, textAlignVertical: 'top' }]} value={ev.memo ?? ''} onChangeText={(t) => update({ memo: t })} placeholder="補足事項があれば入力" placeholderTextColor="#a0aec0" multiline />

          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 20 }}>
            <Text style={styles.formLabel}>通知</Text>
            <TouchableOpacity onPress={() => update({ notifyEnabled: !ev.notifyEnabled })} style={{ paddingHorizontal: 16, paddingVertical: 8, borderRadius: 20, backgroundColor: ev.notifyEnabled ? COLORS.success : '#e2e8f0' }}>
              <Text style={{ color: ev.notifyEnabled ? '#fff' : '#718096', fontWeight: 'bold', fontSize: 13 }}>{ev.notifyEnabled ? 'ON' : 'OFF'}</Text>
            </TouchableOpacity>
          </View>

          {ev.notifyEnabled && (
            <View style={{ marginTop: 12 }}>
              <Text style={{ fontSize: 12, color: COLORS.subtext, marginBottom: 8 }}>何日前に通知しますか？</Text>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                {[0, 1, 3, 7, 14].map(d => {
                  const selected = ev.notifyDaysBefore === d;
                  return (
                    <TouchableOpacity key={d} onPress={() => update({ notifyDaysBefore: d })} style={{ paddingHorizontal: 14, paddingVertical: 8, borderRadius: 16, backgroundColor: selected ? COLORS.primary : '#f1f5f9', borderWidth: 1, borderColor: selected ? COLORS.primary : COLORS.border }}>
                      <Text style={{ fontSize: 12, fontWeight: 'bold', color: selected ? '#fff' : '#4a5568' }}>{d === 0 ? '当日' : `${d}日前`}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </View>
          )}
        </View>

        <TouchableOpacity style={[styles.menuBtn, { borderColor: COLORS.primary, borderWidth: 2, opacity: isValid ? 1 : 0.5 }]} disabled={!isValid}
          onPress={async () => { await upsertExamEvent(ev, isAddingEvent); setEditingEvent(null); setIsAddingEvent(false); }}>
          <Text style={[styles.menuBtnTitle, { textAlign: 'center' }]}>保存する</Text>
        </TouchableOpacity>

        {!isAddingEvent && (
          <TouchableOpacity style={[styles.menuBtn, { borderColor: '#e74c3c', borderWidth: 2 }]}
            onPress={() => confirmDeleteExamEvent(ev.id, ev.title)}>
            <Text style={[styles.menuBtnTitle, { textAlign: 'center', color: '#e74c3c' }]}>この予定を削除</Text>
          </TouchableOpacity>
        )}

        <TouchableOpacity style={styles.backBtn} onPress={() => { setEditingEvent(null); setIsAddingEvent(false); }}>
          <Text style={styles.backBtnText}>← キャンセルして戻る</Text>
        </TouchableOpacity>
      </ScrollView>
    );
  }

  // ===== ハブ画面：ボトムタブで4つの大分類を切り替える =====
  if (screen === 'hub') {
    const { totals, overallRate, weakSubs } = analysisSummary;
    const { monthLabel, cells, eventsByDate, pad } = calendarData;
    const { upcoming, past } = scheduleLists;
    const { pct: studyProgressPct, firstExam } = studyProgress;

    const todayStr = (() => {
      const t = new Date();
      return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`;
    })();

    const thisMonthKeys = Object.keys(dailyLog).filter(k =>
      k.startsWith(`${calendarMonth.year}-${pad(calendarMonth.month + 1)}`)
    );
    const monthTotal = thisMonthKeys.reduce((s, k) => s + (dailyLog[k] ?? 0), 0);
    const monthCorrect = overallRate;

    const nextExam = [...examEvents]
      .filter(e => e.category === '試験' && daysUntil(e.date) >= 0)
      .sort((a, b) => a.date.localeCompare(b.date))[0];

    const heatLevel = (count: number) => {
      if (count >= 15) return 4;
      if (count >= 10) return 3;
      if (count >= 5)  return 2;
      if (count >= 1)  return 1;
      return 0;
    };
    const heatColors = ['transparent', '#B5D4F4', '#85B7EB', '#378ADD', '#185FA5'];

    // ── おまかせ出題：調整パネル用のミックスプレビュー（現在の絞り込み条件での内訳） ──
    const smartPool = STANDALONE_QUESTIONS.filter((q: any) => !smartExcludedSubjects.has(q.subject));
    const smartWrongCount = smartPool.filter((q: any) => q.id && wrongIds.has(q.id)).length;
    const smartUnansweredCount = smartPool.filter((q: any) => !q.id || !answeredQuestionIds.has(q.id)).length;
    const smartWeakSubject = SUBJECT_META
      .map((sub) => ({ key: sub.key, rate: stats[sub.key] && stats[sub.key].total >= 5 ? stats[sub.key].correct / stats[sub.key].total : null }))
      .filter((s) => s.rate !== null && !smartExcludedSubjects.has(s.key))
      .sort((a, b) => (a.rate as number) - (b.rate as number))[0];

    // ── 「今日の5問」：本日分の進捗状態 ──
    const isTodayFiveDoneToday = !!todayFiveRecord && todayFiveRecord.date === getTodayStr() && todayFiveRecord.completed;
    const isTodayFiveInProgressToday = !!todayFiveRecord && todayFiveRecord.date === getTodayStr() && !todayFiveRecord.completed;

    return (
      <View style={{ flex: 1 }}>
        <ScrollView style={styles.container} contentContainerStyle={{ paddingBottom: 30 }}>

          {/* ═══════════ 練習問題タブ ═══════════ */}
         {mainTab === 'practice' && (
  <View>
    {/* 学習進捗ゲージ＋習熟度グリッド */}
    <View style={styles.gaugeCard}>
                <ProgressGauge percent={masteryRate} />
                <MasteryGrid buckets={masteryBuckets} />
              </View>

              {/* ── 途中から再開：中断したセッションがあるときだけ表示 ── */}
              {resumeSnapshot && (
                <TouchableOpacity style={styles.reviewWrongBtn} onPress={resumeSession}>
                  <MenuIcon name="flag" color={COLORS.primary} size={20} />
                  <View style={styles.reviewWrongBtnTextWrap}>
                    <Text style={styles.reviewWrongBtnTitle}>前回の続きから</Text>
                    <Text style={styles.reviewWrongBtnDesc}>
                      {resumeSnapshot.subjectName}{resumeSnapshot.topic ? `（${resumeSnapshot.topic}）` : ''}
                      {' '}／ {resumeSnapshot.currentIndex + 1}問目から（全{resumeSnapshot.items.length}問）
                    </Text>
                  </View>
                  <View style={styles.reviewWrongBadge}>
                    <Text style={styles.reviewWrongBadgeText}>{resumeSnapshot.counted.length}/{resumeSnapshot.items.length}</Text>
                  </View>
                </TouchableOpacity>
              )}

              <TouchableOpacity style={styles.reviewWrongBtn} onPress={startTodayFive}>
                <MenuIcon name="flag" color={isTodayFiveDoneToday ? COLORS.success : COLORS.primary} size={20} />
                <View style={styles.reviewWrongBtnTextWrap}>
                  <Text style={styles.reviewWrongBtnTitle}>今日の{todayFiveCount}問</Text>
                  <Text style={styles.reviewWrongBtnDesc}>
                    {isTodayFiveDoneToday
                      ? '本日分は完了しました。また明日挑戦しましょう！'
                      : isTodayFiveInProgressToday
                        ? '続きから解く（苦手・未学習を優先出題）'
                        : 'スキマ時間に苦手・未学習の問題を優先出題'}
                  </Text>
                </View>
                {isTodayFiveDoneToday ? (
                  <View style={[styles.reviewWrongBadge, { backgroundColor: COLORS.success }]}>
                    <Text style={styles.reviewWrongBadgeText}>済✓</Text>
                  </View>
                ) : streak > 0 ? (
                  <View style={styles.reviewWrongBadge}>
                    <Text style={styles.reviewWrongBadgeText}>🔥{streak}日</Text>
                  </View>
                ) : null}
              </TouchableOpacity>

              {wrongIds.size > 0 && (
                <TouchableOpacity style={styles.reviewWrongBtn} onPress={startReviewWrong}>
                  <MenuIcon name="target" color="#c0392b" size={20} />
                  <View style={styles.reviewWrongBtnTextWrap}>
                    <Text style={styles.reviewWrongBtnTitle}>要復習</Text>
                    <Text style={styles.reviewWrongBtnDesc}>まだ身についていない問題をまとめて出題</Text>
                  </View>
                  <View style={styles.reviewWrongBadge}>
                    <Text style={styles.reviewWrongBadgeText}>{wrongIds.size}問</Text>
                  </View>
                </TouchableOpacity>
              )}

              {/* ═══════════ おまかせ出題 ヒーローカード ═══════════ */}
              <View style={styles.smartHeroCard}>
                <View style={styles.smartHeroTitleRow}>
                  <MenuIcon name="shuffle" color={COLORS.primary} size={18} />
                  <Text style={styles.smartHeroTitle}>おまかせ出題</Text>
                  <View style={styles.smartHeroBadge}>
                    <Text style={styles.smartHeroBadgeText}>自動ミックス</Text>
                  </View>
                </View>
                <Text style={styles.smartHeroDesc}>
                  間違えた問題・苦手科目・未学習の問題を自動でスコアリングし、バランスよく出題します。
                </Text>
                <TouchableOpacity style={styles.smartStartBtn} onPress={startSmartQuiz}>
                  <Text style={styles.smartStartBtnText}>▶ {smartCount}問でおまかせスタート</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.smartTuneToggle} onPress={() => setSmartPanelOpen(!smartPanelOpen)}>
                  <Text style={styles.smartTuneToggleText}>{smartPanelOpen ? '▲ 内容を調整' : '▼ 内容を調整'}</Text>
                </TouchableOpacity>

                {smartPanelOpen && (
                  <View style={styles.smartTunePanel}>
                    <Text style={styles.smartTuneLabel}>出題数</Text>
                    <View style={styles.smartChipRow}>
                      {([10, 20, 30] as const).map((n) => (
                        <TouchableOpacity
                          key={n}
                          style={[styles.smartChip, smartCount === n && styles.smartChipActive]}
                          onPress={() => setSmartCount(n)}
                        >
                          <Text style={[styles.smartChipText, smartCount === n && styles.smartChipTextActive]}>{n}問</Text>
                        </TouchableOpacity>
                      ))}
                    </View>

                    <Text style={styles.smartTuneLabel}>重視ポイント</Text>
                    <View style={styles.smartChipRow}>
                      {([
                        { key: 'balance' as const, label: 'バランス' },
                        { key: 'weak' as const, label: '苦手優先' },
                        { key: 'wrong' as const, label: '間違い優先' },
                      ]).map((opt) => (
                        <TouchableOpacity
                          key={opt.key}
                          style={[styles.smartChip, smartWeightMode === opt.key && styles.smartChipActive]}
                          onPress={() => setSmartWeightMode(opt.key)}
                        >
                          <Text style={[styles.smartChipText, smartWeightMode === opt.key && styles.smartChipTextActive]}>{opt.label}</Text>
                        </TouchableOpacity>
                      ))}
                    </View>

                    <Text style={styles.smartTuneLabel}>対象科目（タップで除外／再度タップで戻す）</Text>
                    <View style={styles.smartChipRow}>
                      {SUBJECT_META.map((sub) => {
                        const excluded = smartExcludedSubjects.has(sub.key);
                        return (
                          <TouchableOpacity
                            key={sub.key}
                            style={[styles.smartChip, !excluded && styles.smartChipActive]}
                            onPress={() => {
                              const next = new Set(smartExcludedSubjects);
                              if (excluded) next.delete(sub.key); else next.add(sub.key);
                              setSmartExcludedSubjects(next);
                            }}
                          >
                            <Text style={[styles.smartChipText, !excluded && styles.smartChipTextActive]}>{sub.key}</Text>
                          </TouchableOpacity>
                        );
                      })}
                    </View>

                    <Text style={styles.smartTuneLabel}>この条件での内訳（目安）</Text>
                    <View style={styles.smartMixRow}>
                      {smartWeakSubject && (
                        <View style={styles.smartMixChip}><Text style={styles.smartMixChipText}>{smartWeakSubject.key} 重点</Text></View>
                      )}
                      <View style={styles.smartMixChip}><Text style={styles.smartMixChipText}>復習待ち {smartWrongCount}問</Text></View>
                      <View style={styles.smartMixChip}><Text style={styles.smartMixChipText}>未学習 {smartUnansweredCount}問</Text></View>
                    </View>
                  </View>
                )}
              </View>

              <Text style={styles.sectionLabel}>クイックスタート</Text>

              <TouchableOpacity style={styles.menuBtn} onPress={() => setScreen('practice_subject_select')}>
                <View style={styles.menuBtnRow}>
                  <MenuIconBox name="shuffle" />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.menuBtnTitle}>練習問題</Text>
                    <Text style={styles.menuBtnDesc}>科目を選んで文章・資料読解・図・ランダムから出題</Text>
                  </View>
                </View>
              </TouchableOpacity>

              <TouchableOpacity style={styles.menuBtn} onPress={() => setScreen('past')}>
                <View style={styles.menuBtnRow}>
                  <MenuIconBox name="book" />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.menuBtnTitle}>過去問学習モード</Text>
                    <Text style={styles.menuBtnDesc}>年度・科目を選んでじっくり学習</Text>
                  </View>
                </View>
              </TouchableOpacity>

              <TouchableOpacity style={styles.menuBtn} onPress={() => setScreen('topic_select')}>
                <View style={styles.menuBtnRow}>
                  <MenuIconBox name="target" />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.menuBtnTitle}>トピック別学習</Text>
                    <Text style={styles.menuBtnDesc}>科目内のテーマを絞って集中学習</Text>
                  </View>
                </View>
              </TouchableOpacity>

              <TouchableOpacity style={styles.menuBtn} onPress={() => setScreen('vocab')}>
                <View style={styles.menuBtnRow}>
                  <MenuIconBox name="cards" />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.menuBtnTitle}>単語学習</Text>
                    <Text style={styles.menuBtnDesc}>重要用語をフラッシュカードで暗記</Text>
                  </View>
                </View>
              </TouchableOpacity>
            </View>
          )}

          {/* ═══════════ 進捗率タブ（学習分析＋試験スケジュールを統合）═══════════ */}
          {mainTab === 'progress' && (
            <View>
              <View style={{ flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 6, marginTop: 20, marginBottom: 5 }}>
                <Text style={{ fontSize: 13, color: COLORS.subtext }}>ヤリコミ度</Text>
                <TouchableOpacity
                  onPress={() => showInfoAlert(
                    'ヤリコミ度とは',
                    '同じ問題に連続で正解した回数（連続正解数）が2回以上に達した問題の割合です。\n\n一度正解しただけではカウントされず、間違えた問題は連続正解数がリセットされます。繰り返し解いて定着させた問題だけが「ヤリコミ度」に反映される仕組みです。'
                  )}
                  hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                  style={{ width: 20, height: 20, borderRadius: 10, backgroundColor: '#e2e8f0', alignItems: 'center', justifyContent: 'center' }}
                >
                  <Text style={{ fontSize: 12, fontWeight: 'bold', color: '#4a5568' }}>?</Text>
                </TouchableOpacity>
              </View>

              {/* ヤリコミ度サマリー（常に表示）*/}
              <View style={{ backgroundColor: 'white', borderRadius: 16, padding: 24, alignItems: 'center', borderWidth: 1, borderColor: COLORS.border, marginBottom: 16 }}>
                <Text style={{ fontSize: 38, fontWeight: 'bold', color: COLORS.text }}>{masteryRate.toFixed(1)}%</Text>
                {streak > 0 && (
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: COLORS.primaryLight, borderRadius: 20, paddingHorizontal: 12, paddingVertical: 5, marginTop: 10 }}>
                    <Text style={{ fontSize: 14 }}>🔥</Text>
                    <Text style={{ fontSize: 12, color: COLORS.primaryDark, fontWeight: 'bold' }}>{streak}日連続学習中</Text>
                  </View>
                )}
              </View>

              {wrongIds.size > 0 && (
                <TouchableOpacity style={styles.reviewWrongBtn} onPress={startReviewWrong}>
                  <MenuIcon name="target" color="#c0392b" size={20} />
                  <View style={styles.reviewWrongBtnTextWrap}>
                    <Text style={styles.reviewWrongBtnTitle}>要復習</Text>
                    <Text style={styles.reviewWrongBtnDesc}>まだ身についていない問題をまとめて出題</Text>
                  </View>
                  <View style={styles.reviewWrongBadge}>
                    <Text style={styles.reviewWrongBadgeText}>{wrongIds.size}問</Text>
                  </View>
                </TouchableOpacity>
              )}

              {/* サブタブ切り替え：学習分析 / 試験スケジュール */}
              <View style={{ flexDirection: 'row', gap: 8, marginBottom: 16 }}>
                {([{ key: 'analysis' as const, label: '学習分析' }, { key: 'schedule' as const, label: '試験スケジュール' }]).map(t => (
                  <TouchableOpacity
                    key={t.key}
                    onPress={() => setProgressSubTab(t.key)}
                    style={{ flex: 1, paddingVertical: 10, borderRadius: 20, alignItems: 'center', backgroundColor: progressSubTab === t.key ? COLORS.primary : '#f1f5f9', borderWidth: 1, borderColor: progressSubTab === t.key ? COLORS.primary : COLORS.border }}
                  >
                    <Text style={{ fontSize: 13, fontWeight: progressSubTab === t.key ? 'bold' : 'normal', color: progressSubTab === t.key ? 'white' : '#4a5568' }}>{t.label}</Text>
                  </TouchableOpacity>
                ))}
              </View>

              {/* ── 学習分析 ── */}
              {progressSubTab === 'analysis' && (
                <View>
                  <View style={{ flexDirection: 'row', gap: 8, marginBottom: 20 }}>
                    {(['overview', 'subjects'] as const).map((tab, i) => {
                      const labels = ['概要', '科目別'];
                      return (
                        <TouchableOpacity key={tab} onPress={() => setActiveTab(tab)} style={{ paddingVertical: 6, paddingHorizontal: 14, borderRadius: 20, backgroundColor: activeTab === tab ? COLORS.primary : '#f1f5f9', borderWidth: 1, borderColor: activeTab === tab ? COLORS.primary : COLORS.border }}>
                          <Text style={{ fontSize: 13, fontWeight: activeTab === tab ? 'bold' : 'normal', color: activeTab === tab ? 'white' : '#4a5568' }}>{labels[i]}</Text>
                        </TouchableOpacity>
                      );
                    })}
                  </View>

                  {activeTab === 'overview' && (
                    <View>
                      <View style={{ flexDirection: 'row', gap: 8, marginBottom: 16 }}>
                        {[
                          { label: '解答済み', value: `${totals.total}問`, sub: '全科目合計' },
                          { label: '総合正答率', value: overallRate !== null ? `${overallRate}%` : '—', sub: '合格目安 60%' },
                          { label: '復習待ち', value: `${wrongIds.size}問`, sub: '要復習の問題', danger: wrongIds.size > 0 },
                        ].map((m, i) => (
                          <View key={i} style={{ flex: 1, backgroundColor: '#f8fafc', borderRadius: 10, padding: 12, borderWidth: 1, borderColor: COLORS.border }}>
                            <Text style={{ fontSize: 11, color: COLORS.subtext, marginBottom: 4 }}>{m.label}</Text>
                            <Text style={{ fontSize: 20, fontWeight: 'bold', color: m.danger ? '#e74c3c' : '#2d3748' }}>{m.value}</Text>
                            <Text style={{ fontSize: 10, color: '#a0aec0', marginTop: 2 }}>{m.sub}</Text>
                          </View>
                        ))}
                      </View>

                      <Text style={{ fontSize: 11, color: COLORS.subtext, fontWeight: 'bold', marginBottom: 8 }}>合格ライン達成状況（各科目60%）</Text>
                      <View style={{ backgroundColor: 'white', borderRadius: 12, padding: 16, borderWidth: 1, borderColor: COLORS.border, marginBottom: 16 }}>
                        {SUBJECT_META.map(sub => {
                          const s = stats[sub.key] ?? { total: 0, correct: 0 };
                          const rate = getRate(s);
                          const pct = rate ?? 0;
                          const badgeText = rate === null ? '未解答' : rate >= 60 ? '合格圏' : '要強化';
                          const badgeColor = rate === null ? '#718096' : rate >= 60 ? '#2ecc71' : '#e74c3c';
                          return (
                            <View key={sub.key} style={{ marginBottom: 12 }}>
                              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                                <Text style={{ fontSize: 12, fontWeight: 'bold', color: '#2d3748' }}>{sub.short}</Text>
                                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                                  <View style={{ paddingHorizontal: 8, paddingVertical: 2, borderRadius: 10, backgroundColor: badgeColor + '22' }}>
                                    <Text style={{ fontSize: 11, color: badgeColor, fontWeight: 'bold' }}>{badgeText}</Text>
                                  </View>
                                  <Text style={{ fontSize: 12, color: COLORS.subtext }}>{rate !== null ? `${rate}%` : '—'}</Text>
                                </View>
                              </View>
                              <View style={{ height: 8, backgroundColor: '#f1f5f9', borderRadius: 4, overflow: 'hidden' }}>
                                <View style={{ position: 'absolute', left: 0, top: 0, height: 8, width: `${pct}%` as any, backgroundColor: barColor(rate), borderRadius: 4 }} />
                                <View style={{ position: 'absolute', left: '60%' as any, top: -2, bottom: -2, width: 2, backgroundColor: '#e74c3c', borderRadius: 1 }} />
                              </View>
                            </View>
                          );
                        })}
                      </View>

                      <Text style={{ fontSize: 11, color: COLORS.subtext, fontWeight: 'bold', marginBottom: 8 }}>弱点ピックアップ</Text>
                      <View style={{ backgroundColor: 'white', borderRadius: 12, padding: 16, borderWidth: 1, borderColor: COLORS.border }}>
                        {weakSubs.length === 0 ? (
                          <Text style={{ fontSize: 13, color: COLORS.subtext, textAlign: 'center' }}>
                            {totals.total > 0 ? '現在すべての科目が合格ライン以上です' : '問題を解くと弱点分析が表示されます'}
                          </Text>
                        ) : (
                          <>
                            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
                              {weakSubs.map(s => (
                                <View key={s.key} style={{ flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 20, backgroundColor: '#fff0f0' }}>
                                  <Text style={{ fontSize: 12, color: '#e74c3c', fontWeight: 'bold' }}>{s.short} {getRate(stats[s.key] ?? { total: 0, correct: 0 })}%</Text>
                                </View>
                              ))}
                            </View>
                            <View style={{ backgroundColor: '#f8fafc', borderRadius: 8, padding: 12 }}>
                              <Text style={{ fontSize: 12, color: COLORS.subtext, marginBottom: 6, fontWeight: 'bold' }}>最優先：{weakSubs[0].key}</Text>
                              <Text style={{ fontSize: 13, color: '#4a5568', lineHeight: 20 }}>{SUBJECT_ADVICE[weakSubs[0].key]}</Text>
                            </View>
                          </>
                        )}
                      </View>
                    </View>
                  )}

                  {activeTab === 'subjects' && (
                    <View style={{ backgroundColor: 'white', borderRadius: 12, borderWidth: 1, borderColor: COLORS.border, overflow: 'hidden' }}>
                      {SUBJECT_META.map((sub, i) => {
                        const s = stats[sub.key] ?? { total: 0, correct: 0 };
                        const rate = getRate(s);
                        return (
                          <View key={sub.key} style={{ padding: 14, borderBottomWidth: i < SUBJECT_META.length - 1 ? 1 : 0, borderBottomColor: '#f1f5f9', flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                            <View style={{ width: 36, height: 36, borderRadius: 8, backgroundColor: COLORS.primaryLight, alignItems: 'center', justifyContent: 'center' }}>
                              <MenuIcon name="book" color={COLORS.primary} size={18} />
                            </View>
                            <View style={{ flex: 1, minWidth: 0 }}>
                              <Text style={{ fontSize: 13, fontWeight: 'bold', color: '#2d3748', marginBottom: 4 }} numberOfLines={1}>{sub.key}</Text>
                              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                                <View style={{ flex: 1, height: 5, backgroundColor: '#f1f5f9', borderRadius: 3, overflow: 'hidden' }}>
                                  <View style={{ width: `${rate ?? 0}%` as any, height: 5, backgroundColor: barColor(rate), borderRadius: 3 }} />
                                </View>
                                <Text style={{ fontSize: 11, color: '#a0aec0', minWidth: 50, textAlign: 'right' }}>{s.correct}/{s.total}問</Text>
                              </View>
                            </View>
                            <View style={{ paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12, backgroundColor: rate === null ? '#f1f5f9' : rate >= 70 ? '#d4edda' : rate >= 60 ? '#fff3cd' : '#ffe0e0' }}>
                              <Text style={{ fontSize: 13, fontWeight: 'bold', color: rate === null ? '#718096' : rate >= 70 ? '#2ecc71' : rate >= 60 ? '#EF9F27' : '#e74c3c' }}>
                                {rate !== null ? `${rate}%` : '—'}
                              </Text>
                            </View>
                          </View>
                        );
                      })}
                    </View>
                  )}

                  {wrongIds.size > 0 && (
                    <TouchableOpacity style={{ marginTop: 16, backgroundColor: '#fff0f0', borderRadius: 12, padding: 14, borderWidth: 1, borderColor: '#fca5a5', flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }} onPress={startReviewWrong}>
                      <View>
                        <Text style={{ fontSize: 14, fontWeight: 'bold', color: '#e74c3c' }}>要復習</Text>
                        <Text style={{ fontSize: 12, color: COLORS.subtext, marginTop: 2 }}>{wrongIds.size}問が復習待ちです</Text>
                      </View>
                      <Text style={{ fontSize: 20, color: '#e74c3c' }}>›</Text>
                    </TouchableOpacity>
                  )}
                </View>
              )}

              {/* ── 試験スケジュール ── */}
              {progressSubTab === 'schedule' && (
                <View>
                  {notifPermissionGranted === false && (
                    <View style={[styles.howtoCard, { backgroundColor: '#fffbeb', borderColor: '#fcd34d', marginBottom: 16 }]}>
                      <Text style={{ fontSize: 12, color: '#92400e', lineHeight: 18 }}>
                        通知が許可されていません。予定の編集画面で通知をONにする際に許可を求めます。
                      </Text>
                    </View>
                  )}

                  <View style={{ flexDirection: 'row', gap: 8, marginBottom: 16 }}>
                    {([{ key: 'list' as const, label: 'リスト' }, { key: 'calendar' as const, label: 'カレンダー' }]).map(t => (
                      <TouchableOpacity key={t.key} onPress={() => setScheduleTab(t.key)} style={{ flex: 1, paddingVertical: 8, borderRadius: 20, alignItems: 'center', backgroundColor: scheduleTab === t.key ? COLORS.primary : '#f1f5f9', borderWidth: 1, borderColor: scheduleTab === t.key ? COLORS.primary : COLORS.border }}>
                        <Text style={{ fontSize: 13, fontWeight: scheduleTab === t.key ? 'bold' : 'normal', color: scheduleTab === t.key ? 'white' : '#4a5568' }}>{t.label}</Text>
                      </TouchableOpacity>
                    ))}
                  </View>

                  {scheduleTab === 'calendar' && (
                    <View>
                      <View style={{ flexDirection: 'row', gap: 8, marginBottom: 12 }}>
                        {[
                          { label: '今月の解答数', value: `${monthTotal}問` },
                          { label: '総合正答率', value: monthCorrect !== null ? `${monthCorrect}%` : '—' },
                          { label: nextExam ? `${nextExam.title.replace('（1日目）', '').replace('（2日目）', '')}まで` : '次の試験', value: nextExam ? `${daysUntil(nextExam.date)}日` : '—' },
                        ].map((m, i) => (
                          <View key={i} style={{ flex: 1, backgroundColor: '#f8fafc', borderRadius: 8, padding: 10, borderWidth: 1, borderColor: COLORS.border }}>
                            <Text style={{ fontSize: 10, color: COLORS.subtext, marginBottom: 3 }}>{m.label}</Text>
                            <Text style={{ fontSize: 17, fontWeight: 'bold', color: '#2d3748' }}>{m.value}</Text>
                          </View>
                        ))}
                      </View>

                      {studyProgressPct !== null && firstExam && (
                        <View style={{ backgroundColor: 'white', borderRadius: 10, padding: 12, borderWidth: 1, borderColor: COLORS.border, marginBottom: 14 }}>
                          <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 }}>
                            <Text style={{ fontSize: 12, color: COLORS.subtext }}>学習期間の進捗</Text>
                            <Text style={{ fontSize: 12, fontWeight: 'bold', color: '#2d3748' }}>{studyProgressPct}% 経過</Text>
                          </View>
                          <View style={{ height: 6, backgroundColor: '#f1f5f9', borderRadius: 4, overflow: 'hidden', marginBottom: 6 }}>
                            <View style={{ width: `${studyProgressPct}%` as any, height: 6, backgroundColor: COLORS.primary, borderRadius: 4 }} />
                          </View>
                          <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                            <Text style={{ fontSize: 10, color: '#a0aec0' }}>学習開始</Text>
                            <Text style={{ fontSize: 10, color: '#e74c3c', fontWeight: 'bold' }}>▲ 今日</Text>
                            <Text style={{ fontSize: 10, color: '#a0aec0' }}>{firstExam.title}</Text>
                          </View>
                        </View>
                      )}

                      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                        <TouchableOpacity onPress={() => setCalendarMonth(m => { const d = new Date(m.year, m.month - 1, 1); return { year: d.getFullYear(), month: d.getMonth() }; })} style={{ padding: 8 }}>
                          <Text style={{ fontSize: 18, color: COLORS.primary, fontWeight: 'bold' }}>‹</Text>
                        </TouchableOpacity>
                        <Text style={{ fontSize: 16, fontWeight: 'bold', color: '#2c3e50' }}>{monthLabel}</Text>
                        <TouchableOpacity onPress={() => setCalendarMonth(m => { const d = new Date(m.year, m.month + 1, 1); return { year: d.getFullYear(), month: d.getMonth() }; })} style={{ padding: 8 }}>
                          <Text style={{ fontSize: 18, color: COLORS.primary, fontWeight: 'bold' }}>›</Text>
                        </TouchableOpacity>
                      </View>

                      <View style={{ flexDirection: 'row', marginBottom: 4 }}>
                        {['日', '月', '火', '水', '木', '金', '土'].map((w, i) => (
                          <Text key={w} style={{ flex: 1, textAlign: 'center', fontSize: 11, fontWeight: 'bold', color: i === 0 ? '#e74c3c' : i === 6 ? COLORS.primary : COLORS.subtext }}>{w}</Text>
                        ))}
                      </View>

                      <View style={{ flexDirection: 'row', flexWrap: 'wrap', backgroundColor: 'white', borderRadius: 12, borderWidth: 1, borderColor: COLORS.border, overflow: 'hidden' }}>
                        {cells.map((day, idx) => {
                          const dateStr = day ? `${calendarMonth.year}-${pad(calendarMonth.month + 1)}-${pad(day)}` : '';
                          const dayEvents = day ? (eventsByDate[dateStr] ?? []) : [];
                          const isToday = dateStr === todayStr;
                          const count = day ? (dailyLog[dateStr] ?? 0) : 0;
                          const level = heatLevel(count);
                          const heatBg = level > 0 ? heatColors[level] : undefined;
                          return (
                            <View key={idx} style={{ width: '14.28%', minHeight: 64, borderWidth: 0.5, borderColor: '#f1f5f9', padding: 4, backgroundColor: heatBg }}>
                              {day && (
                                <>
                                  <Text style={{ fontSize: 11, fontWeight: isToday ? 'bold' : 'normal', color: isToday ? '#fff' : '#4a5568', backgroundColor: isToday ? COLORS.primary : 'transparent', width: 18, height: 18, borderRadius: 9, textAlign: 'center', lineHeight: 18 }}>{day}</Text>
                                  {dayEvents.slice(0, 2).map(ev => {
                                    const c = categoryColor(ev.category);
                                    return (
                                      <TouchableOpacity key={ev.id} onPress={() => setEditingEvent(ev)} style={{ backgroundColor: c.bg, borderRadius: 4, paddingHorizontal: 3, paddingVertical: 1, marginTop: 2 }}>
                                        <Text style={{ fontSize: 8, color: c.color, fontWeight: 'bold' }} numberOfLines={1}>{ev.title}</Text>
                                      </TouchableOpacity>
                                    );
                                  })}
                                </>
                              )}
                            </View>
                          );
                        })}
                      </View>

                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 10, marginBottom: 4 }}>
                        <Text style={{ fontSize: 11, color: COLORS.subtext }}>学習量</Text>
                        {(['transparent', '#B5D4F4', '#85B7EB', '#378ADD', '#185FA5']).map((c, i) => (
                          <View key={i} style={{ width: 12, height: 12, borderRadius: 3, backgroundColor: c, borderWidth: c === 'transparent' ? 0.5 : 0, borderColor: COLORS.border }} />
                        ))}
                        <Text style={{ fontSize: 11, color: COLORS.subtext }}>多い</Text>
                      </View>

                      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 4 }}>
                        {(['申込', '試験', '発表'] as const).map(cat => {
                          const c = categoryColor(cat);
                          return (
                            <View key={cat} style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                              <View style={{ width: 10, height: 10, borderRadius: 3, backgroundColor: c.color }} />
                              <Text style={{ fontSize: 11, color: COLORS.subtext }}>{cat}</Text>
                            </View>
                          );
                        })}
                      </View>
                    </View>
                  )}

                  {scheduleTab === 'list' && (
                    <View>
                      <Text style={{ fontSize: 12, color: COLORS.subtext, fontWeight: 'bold', marginBottom: 8 }}>これからの予定</Text>
                      {upcoming.length === 0 ? (
                        <Text style={{ fontSize: 13, color: '#a0aec0', marginBottom: 16 }}>予定はありません</Text>
                      ) : upcoming.map(ev => {
                        const c = categoryColor(ev.category);
                        const d = daysUntil(ev.date);
                        return (
                          <TouchableOpacity key={ev.id} style={styles.scheduleCard} onPress={() => setEditingEvent(ev)}>
                            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                              <View style={{ flex: 1 }}>
                                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                                  <View style={{ paddingHorizontal: 8, paddingVertical: 2, borderRadius: 10, backgroundColor: c.bg }}>
                                    <Text style={{ fontSize: 11, fontWeight: 'bold', color: c.color }}>{ev.category}</Text>
                                  </View>
                                  {ev.notifyEnabled && <Text style={{ fontSize: 12 }}>🔔</Text>}
                                </View>
                                <Text style={{ fontSize: 15, fontWeight: 'bold', color: '#2c3e50' }}>{ev.title}</Text>
                                <Text style={{ fontSize: 12, color: COLORS.subtext, marginTop: 2 }}>{ev.date}</Text>
                                {!!ev.memo && <Text style={{ fontSize: 12, color: '#a0aec0', marginTop: 4 }}>{ev.memo}</Text>}
                              </View>
                              <View style={{ alignItems: 'flex-end' }}>
                                <Text style={{ fontSize: 20, fontWeight: 'bold', color: d === 0 ? '#e74c3c' : COLORS.primary }}>{d === 0 ? '本日' : `${d}日`}</Text>
                                {d !== 0 && <Text style={{ fontSize: 10, color: '#a0aec0' }}>後</Text>}
                              </View>
                            </View>
                          </TouchableOpacity>
                        );
                      })}

                      {past.length > 0 && (
                        <>
                          <Text style={{ fontSize: 12, color: COLORS.subtext, fontWeight: 'bold', marginTop: 16, marginBottom: 8 }}>終了した予定</Text>
                          {past.map(ev => {
                            const c = categoryColor(ev.category);
                            return (
                              <TouchableOpacity key={ev.id} style={[styles.scheduleCard, { opacity: 0.55 }]} onPress={() => setEditingEvent(ev)}>
                                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                                  <View style={{ paddingHorizontal: 8, paddingVertical: 2, borderRadius: 10, backgroundColor: c.bg }}>
                                    <Text style={{ fontSize: 11, fontWeight: 'bold', color: c.color }}>{ev.category}</Text>
                                  </View>
                                </View>
                                <Text style={{ fontSize: 14, fontWeight: 'bold', color: '#2c3e50' }}>{ev.title}</Text>
                                <Text style={{ fontSize: 12, color: COLORS.subtext, marginTop: 2 }}>{ev.date}</Text>
                              </TouchableOpacity>
                            );
                          })}
                        </>
                      )}
                    </View>
                  )}

                  <TouchableOpacity
                    style={[styles.menuBtn, { borderColor: COLORS.primary, borderWidth: 2, marginTop: 16 }]}
                    onPress={() => {
                      setEditingEvent({ id: `custom-${Date.now()}`, title: '', date: todayStr, category: '試験', memo: '', notifyEnabled: false, notifyDaysBefore: 1, notificationId: null });
                      setIsAddingEvent(true);
                    }}
                  >
                    <Text style={styles.menuBtnTitle}>予定を追加する</Text>
                  </TouchableOpacity>

                  <TouchableOpacity style={styles.resetBtn} onPress={confirmResetExamScheduleToDefault}>
                    <Text style={styles.resetBtnText}>デフォルトの日程に戻す</Text>
                  </TouchableOpacity>
                </View>
              )}
            </View>
          )}

          {/* ═══════════ 設定タブ ═══════════ */}
          {mainTab === 'settings' && (
            <View>
              <Text style={styles.title}>設定</Text>
              <Text style={styles.subtitle}>アプリの挙動をカスタマイズできます</Text>

              <View style={styles.card}>
                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                  <View style={{ flex: 1, marginRight: 12 }}>
                    <Text style={{ fontSize: 15, fontWeight: 'bold', color: '#2c3e50', marginBottom: 4 }}>回答後に解説を自動表示</Text>
                    <Text style={{ fontSize: 12, color: COLORS.subtext, lineHeight: 18 }}>
                      ONにすると、問題に回答した直後に解説が自動で開きます。OFFにすると、これまで通り「詳しく解説を見る」をタップするまで解説は隠れたままになります。
                    </Text>
                  </View>
                  <TouchableOpacity
                    onPress={() => updateAutoShowExplanation(!autoShowExplanation)}
                    style={{ paddingHorizontal: 16, paddingVertical: 8, borderRadius: 20, backgroundColor: autoShowExplanation ? COLORS.success : '#e2e8f0' }}
                  >
                    <Text style={{ color: autoShowExplanation ? '#fff' : '#718096', fontWeight: 'bold', fontSize: 13 }}>
                      {autoShowExplanation ? 'ON' : 'OFF'}
                    </Text>
                  </TouchableOpacity>
                </View>
              </View>

              <View style={styles.card}>
                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                  <View style={{ flex: 1, marginRight: 12 }}>
                    <Text style={{ fontSize: 15, fontWeight: 'bold', color: '#2c3e50', marginBottom: 4 }}>毎日「今日の5問」通知</Text>
                    <Text style={{ fontSize: 12, color: COLORS.subtext, lineHeight: 18 }}>
                      ONにすると、毎日設定した時刻にプッシュ通知が届きます。通知をタップするとその場で5問の練習が始まります。
                    </Text>
                  </View>
                  <TouchableOpacity
                    onPress={() => updateDailyReminderEnabled(!dailyReminderEnabled)}
                    style={{ paddingHorizontal: 16, paddingVertical: 8, borderRadius: 20, backgroundColor: dailyReminderEnabled ? COLORS.success : '#e2e8f0' }}
                  >
                    <Text style={{ color: dailyReminderEnabled ? '#fff' : '#718096', fontWeight: 'bold', fontSize: 13 }}>
                      {dailyReminderEnabled ? 'ON' : 'OFF'}
                    </Text>
                  </TouchableOpacity>
                </View>

                {dailyReminderEnabled && (
                  <View style={{ marginTop: 14, paddingTop: 14, borderTopWidth: 1, borderTopColor: '#f0f0f0' }}>
                    <Text style={{ fontSize: 13, fontWeight: 'bold', color: '#2c3e50', marginBottom: 8 }}>通知時刻</Text>
                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                      {[7, 8, 12, 19, 20, 21, 22, 23].map((h) => {
                        const active = dailyReminderHour === h && dailyReminderMinute === 0;
                        return (
                          <TouchableOpacity
                            key={h}
                            onPress={() => updateDailyReminderTime(h, 0)}
                            style={{
                              paddingHorizontal: 14, paddingVertical: 8, borderRadius: 16,
                              backgroundColor: active ? COLORS.primary : '#f0f0f0',
                            }}
                          >
                            <Text style={{ fontSize: 13, fontWeight: 'bold', color: active ? '#fff' : '#4a5568' }}>
                              {h}:00
                            </Text>
                          </TouchableOpacity>
                        );
                      })}
                    </View>
                    {!notifPermissionGranted && (
                      <Text style={{ fontSize: 12, color: '#c0392b', marginTop: 10 }}>
                        端末の通知が許可されていないため、このままでは通知が届きません。端末の設定アプリから通知を許可してください。
                      </Text>
                    )}
                  </View>
                )}

                {/* ── 「今日の5問」の1日あたりの出題数（通知ON/OFFに関わらず常に選べる） ── */}
                <View style={{ marginTop: 14, paddingTop: 14, borderTopWidth: 1, borderTopColor: '#f0f0f0' }}>
                  <Text style={{ fontSize: 13, fontWeight: 'bold', color: '#2c3e50', marginBottom: 8 }}>1日の出題数</Text>
                  <View style={{ flexDirection: 'row', gap: 8 }}>
                    {([5, 10] as const).map((n) => {
                      const active = todayFiveCount === n;
                      return (
                        <TouchableOpacity
                          key={n}
                          onPress={() => updateTodayFiveCount(n)}
                          style={{
                            paddingHorizontal: 18, paddingVertical: 8, borderRadius: 16,
                            backgroundColor: active ? COLORS.primary : '#f0f0f0',
                          }}
                        >
                          <Text style={{ fontSize: 13, fontWeight: 'bold', color: active ? '#fff' : '#4a5568' }}>
                            {n}問
                          </Text>
                        </TouchableOpacity>
                      );
                    })}
                  </View>
                  <Text style={{ fontSize: 11, color: COLORS.subtext, marginTop: 8, lineHeight: 16 }}>
                    ※ 変更は明日以降の新しい出題セットから反映されます（本日分がすでに始まっている場合は、そのまま完了させられます）。
                  </Text>
                </View>
              </View>

              {/* ── 復習リマインダー(忘却曲線通知)：新規追加 ──────────────
                  間違えた・まだ習得できていない問題を、1日後/3日後/7日後の
                  節目でまとめて思い出させる通知。個別問題ごとではなく
                  1日1件の集約通知として届く(理由はreviewReminderService.ts参照)。 */}
              <View style={styles.card}>
                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                  <View style={{ flex: 1, marginRight: 12 }}>
                    <Text style={{ fontSize: 15, fontWeight: 'bold', color: '#2c3e50', marginBottom: 4 }}>復習リマインダー</Text>
                    <Text style={{ fontSize: 12, color: COLORS.subtext, lineHeight: 18 }}>
                      間違えた・まだ習得できていない問題を、1日後・3日後・7日後の節目でまとめて通知します。通知をタップすると要復習の問題がその場で始まります。
                    </Text>
                    {scheduledReviewCount > 0 && (
                      <Text style={{ fontSize: 12, color: COLORS.primary, fontWeight: 'bold', marginTop: 6 }}>
                        現在 {scheduledReviewCount}問 が復習待ちリストに入っています
                      </Text>
                    )}
                  </View>
                  <TouchableOpacity
                    onPress={() => updateReviewRemindersEnabled(!reviewRemindersEnabled)}
                    style={{ paddingHorizontal: 16, paddingVertical: 8, borderRadius: 20, backgroundColor: reviewRemindersEnabled ? COLORS.success : '#e2e8f0' }}
                  >
                    <Text style={{ color: reviewRemindersEnabled ? '#fff' : '#718096', fontWeight: 'bold', fontSize: 13 }}>
                      {reviewRemindersEnabled ? 'ON' : 'OFF'}
                    </Text>
                  </TouchableOpacity>
                </View>

                {reviewRemindersEnabled && (
                  <View style={{ marginTop: 14, paddingTop: 14, borderTopWidth: 1, borderTopColor: '#f0f0f0' }}>
                    <Text style={{ fontSize: 13, fontWeight: 'bold', color: '#2c3e50', marginBottom: 8 }}>通知時刻</Text>
                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                      {[7, 8, 9, 12, 19, 20, 21].map((h) => {
                        const active = reviewReminderHour === h && reviewReminderMinute === 0;
                        return (
                          <TouchableOpacity
                            key={h}
                            onPress={() => updateReviewReminderTime(h, 0)}
                            style={{
                              paddingHorizontal: 14, paddingVertical: 8, borderRadius: 16,
                              backgroundColor: active ? COLORS.primary : '#f0f0f0',
                            }}
                          >
                            <Text style={{ fontSize: 13, fontWeight: 'bold', color: active ? '#fff' : '#4a5568' }}>
                              {h}:00
                            </Text>
                          </TouchableOpacity>
                        );
                      })}
                    </View>
                    {!notifPermissionGranted && (
                      <Text style={{ fontSize: 12, color: '#c0392b', marginTop: 10 }}>
                        端末の通知が許可されていないため、このままでは通知が届きません。端末の設定アプリから通知を許可してください。
                      </Text>
                    )}
                  </View>
                )}
              </View>

              {RANKING_ENABLED && (
              <TouchableOpacity style={styles.menuBtn} onPress={() => { setScreen('ranking'); refreshRanking(); }}>
                <View style={styles.menuBtnRow}>
                  <MenuIconBox name="flag" />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.menuBtnTitle}>みんなの学習ランキング</Text>
                    <Text style={styles.menuBtnDesc}>直近7日間の解答数で、匿名のニックネームだけで気軽に競い合えます</Text>
                  </View>
                </View>
              </TouchableOpacity>
              )}

              <TouchableOpacity style={styles.menuBtn} onPress={() => { setHowtoTab('modes'); setScreen('howto'); }}>
                <View style={styles.menuBtnRow}>
                  <MenuIconBox name="book" />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.menuBtnTitle}>使い方ガイド</Text>
                    <Text style={styles.menuBtnDesc}>各モードの説明・問題の解き方・合格のコツを確認できます</Text>
                  </View>
                </View>
              </TouchableOpacity>

              <TouchableOpacity style={styles.resetBtn} onPress={confirmResetAllStats}>
                <Text style={styles.resetBtnText}>学習履歴をリセット</Text>
              </TouchableOpacity>

              {/* ── 免責事項 ───────────────────────── */}
              <View style={styles.disclaimerCard}>
                <Text style={styles.disclaimerTitle}>このアプリについて</Text>
                <Text style={styles.disclaimerText}>
                  本アプリは、一般社団法人日本中小企業診断士協会連合会・経済産業省その他の公的機関とは一切関係のない、非公式の学習アプリです。過去問題は、同連合会が公表した中小企業診断士試験の問題を出典を明記して引用したもので、解説は本アプリが独自に作成したものです。「オリジナル問題」と表示した問題は、過去問を参考に本アプリが独自に作成した演習問題です。法令・制度は改正される場合があります。内容の正確性は保証されませんので、受験の際は必ず最新の公式情報をご確認ください。
                </Text>
                {!!PRIVACY_POLICY_URL && (
                  <TouchableOpacity onPress={() => Linking.openURL(PRIVACY_POLICY_URL)} style={{ marginTop: 10 }}>
                    <Text style={[styles.disclaimerText, { color: '#3478F6', textDecorationLine: 'underline' }]}>プライバシーポリシー</Text>
                  </TouchableOpacity>
                )}
                {!!SUPPORT_URL && (
                  <TouchableOpacity onPress={() => Linking.openURL(SUPPORT_URL)} style={{ marginTop: 6 }}>
                    <Text style={[styles.disclaimerText, { color: '#3478F6', textDecorationLine: 'underline' }]}>お問い合わせ</Text>
                  </TouchableOpacity>
                )}
                {!!SUPPORT_EMAIL && (
                  <TouchableOpacity onPress={() => Linking.openURL(`mailto:${SUPPORT_EMAIL}`)} style={{ marginTop: 6 }}>
                    <Text style={[styles.disclaimerText, { color: '#3478F6', textDecorationLine: 'underline' }]}>お問い合わせ：{SUPPORT_EMAIL}</Text>
                  </TouchableOpacity>
                )}
              </View>
            </View>
          )}
        </ScrollView>

        <BottomTabBar />

  
      </View>
    );
  }

  // 使い方（3タブ構成）
  if (screen === 'howto') {
    const tabLabels: { key: 'modes' | 'howto' | 'tips'; label: string }[] = [
      { key: 'modes', label: '各モード説明' },
      { key: 'howto', label: '問題の解き方' },
      { key: 'tips', label: '合格のコツ' },
    ];

    const modes = [
      { title: 'ランダム練習', badge: 'まずここから', badgeBg: '#E6F1FB', badgeColor: '#185FA5', desc: '全科目・全年度の練習問題から10問をランダムに出題。隙間時間に気軽に取り組めます。最初の一歩として最適です。' },
      { title: '過去問学習モード', badge: '本番形式', badgeBg: '#EAF3DE', badgeColor: '#3B6D11', desc: '年度と科目を選んで全問通しで解きます。2016〜2025年度（10年分）×7科目に対応。過去問のみを収録しており、実力を本番に近い形で確認できます。' },
      { title: 'トピック別学習', badge: '苦手克服', badgeBg: '#EEEDFE', badgeColor: '#4B44B5', desc: '「マクロ経済学だけ」「会社法だけ」など科目内の特定テーマに絞って集中学習できます。弱点ピンポイント対策に。' },
      { title: 'おまかせ出題', badge: '自動ミックス', badgeBg: '#E1F5EE', badgeColor: '#0F7A56', desc: '間違えた問題・苦手科目・未学習の問題を自動でスコアリングし、バランスよく出題します。ワンタップで開始でき、出題数や重視ポイントも調整できます。' },
      { title: '単語学習', badge: '暗記特化', badgeBg: '#FFF3DC', badgeColor: '#9A6A00', desc: '練習問題タブ内のフラッシュカードで重要用語をテンポよく暗記できます。「まだ」を選んだ単語は自動で復習リストに入り、カードからは関連する過去問にも飛べます。' },
      { title: '試験スケジュール', badge: '日程管理', badgeBg: '#E6F1FB', badgeColor: '#185FA5', desc: '進捗率タブの中で、申込期限・試験日・合格発表日をカレンダーとリストで確認できます。予定ごとに通知のON/OFFと「何日前に知らせるか」を設定できます。' },
      { title: '要復習', badge: '弱点克服', badgeBg: '#FCEBEB', badgeColor: '#A32D2D', desc: 'まだ身についていない問題（間違えた問題や、正解したもののもう一度確認が必要な問題）を集めて出題します。画面右下のフローティングボタンからいつでも開けます。正解すると自動でリストから外れます。直前期の最終確認にも最適です。' },
      { title: '進捗率・学習分析', badge: '分析・アドバイス', badgeBg: '#FAEEDA', badgeColor: '#7A4A00', desc: '科目別の正答率グラフと合格ライン達成状況を確認できます。正答率に基づいて優先すべき科目と具体的な学習アドバイスを自動で提示します。' },
    ];

    const steps = [
      { num: '1', title: '問題文を読んで選択肢をタップ', desc: 'ア〜オから1つ選ぶと即座に正誤が表示されます。緑が正解・赤が不正解です。' },
      { num: '2', title: '解説を必ず確認する', desc: '「詳しく解説を見る」をタップすると、正解の根拠と各選択肢が誤りである理由が表示されます。正解した問題でも読む習慣をつけましょう。' },
      { num: '3', title: '図・グラフのある問題', desc: '「この問題の図・グラフを表示する」ボタンで資料を確認できます。最初は隠れているので必要に応じて開いてください。表示された図は、タップすると全画面でピンチズームしながら確認できます。' },
      { num: '4', title: '要復習は自動で記録される', desc: '不正解の問題や、正解したもののまだ確実とはいえない問題は自動で「要復習」に追加されます。画面右下のフローティングボタンから「要復習」モードに再挑戦できます。しっかり解けるようになると自動で外れます。' },
      { num: '5', title: '結果画面で成績と進捗を確認', desc: '全問解き終わると結果画面が表示され、今回の正答率と、全問題に対する累計の進捗率を確認できます。画面下の「✕ 問題を終了」でいつでも途中で終了することもできます。' },
    ];

    const tips = [
      { color: COLORS.primary, title: '合格ラインは各科目60%', body: '1科目でも40%未満になると科目別足切りの可能性があります。まず苦手科目を60%以上に引き上げることを最優先にしましょう。' },
      { color: '#1D9E75', title: '要復習は宝の山', body: '要復習の問題には「自分が理解できていない箇所」が凝縮されています。画面右下のフローティングボタンから定期的に「要復習」モードで潰していきましょう。しっかり解けるようになると自動で外れます。' },
      { color: '#EF9F27', title: '解説は正解した問題も読む', body: '選択肢を消去法で正解した場合、根拠を正確に理解できていないことがあります。「なぜ他の選択肢が間違いか」を説明できるレベルを目指しましょう。' },
      { color: '#7F77DD', title: '進捗率タブを定期的に確認', body: '「進捗率」タブでは弱点科目を自動判定し、科目ごとの具体的な学習アドバイスを提示します。週1回は確認して学習の方向性を修正しましょう。' },
      { color: '#D4537E', title: '直前期は要復習を集中攻略', body: '試験1〜2週間前は新しい問題より「要復習」の繰り返しが効果的です。ランダム練習も並行して感覚を維持しておきましょう。' },
    ];

    return (
      <ScrollView style={styles.container} contentContainerStyle={{ paddingBottom: 140 }}>
        <Text style={styles.title}>使い方ガイド</Text>
        <Text style={styles.subtitle}>診断士 過去問ドリルの使い方</Text>

        <View style={{ flexDirection: 'row', gap: 6, marginBottom: 20 }}>
          {tabLabels.map((t) => (
            <TouchableOpacity key={t.key} onPress={() => setHowtoTab(t.key)} style={{ flex: 1, paddingVertical: 8, borderRadius: 20, alignItems: 'center', backgroundColor: howtoTab === t.key ? COLORS.primary : '#f1f5f9', borderWidth: 1, borderColor: howtoTab === t.key ? COLORS.primary : COLORS.border }}>
              <Text style={{ fontSize: 12, fontWeight: howtoTab === t.key ? 'bold' : 'normal', color: howtoTab === t.key ? 'white' : '#4a5568' }}>{t.label}</Text>
            </TouchableOpacity>
          ))}
        </View>

        {howtoTab === 'modes' && (
          <View>
            {modes.map((m) => (
              <View key={m.title} style={styles.howtoCard}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 10 }}>
                  <Text style={styles.howtoCardTitle}>{m.title}</Text>
                  {m.badge && (
                    <View style={{ paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10, backgroundColor: m.badgeBg, marginLeft: 'auto' }}>
                      <Text style={{ fontSize: 11, fontWeight: 'bold', color: m.badgeColor }}>{m.badge}</Text>
                    </View>
                  )}
                </View>
                <Text style={styles.howtoCardDesc}>{m.desc}</Text>
              </View>
            ))}
          </View>
        )}

        {howtoTab === 'howto' && (
          <View>
            <View style={[styles.howtoCard, { marginBottom: 16 }]}>
              <Text style={[styles.howtoCardTitle, { marginBottom: 10 }]}>回答後の画面の見方</Text>
              <View style={{ flexDirection: 'row', gap: 10, marginBottom: 8 }}>
                <View style={{ flex: 1, backgroundColor: '#2ecc71', padding: 10, borderRadius: 8, alignItems: 'center' }}>
                  <Text style={{ color: 'white', fontWeight: 'bold', fontSize: 13 }}>✨ 正解！</Text>
                  <Text style={{ color: 'white', fontSize: 11, marginTop: 3 }}>選択肢が緑色に</Text>
                </View>
                <View style={{ flex: 1, backgroundColor: '#e74c3c', padding: 10, borderRadius: 8, alignItems: 'center' }}>
                  <Text style={{ color: 'white', fontWeight: 'bold', fontSize: 13 }}>❌ 不正解...</Text>
                  <Text style={{ color: 'white', fontSize: 11, marginTop: 3 }}>選択肢が赤色に</Text>
                </View>
              </View>
              <Text style={{ fontSize: 12, color: COLORS.subtext }}>正解・不正解にかかわらず解説ボタンが表示されます</Text>
            </View>
            {steps.map((s) => (
              <View key={s.num} style={{ flexDirection: 'row', gap: 12, alignItems: 'flex-start', marginBottom: 16 }}>
                <View style={styles.stepNum}><Text style={styles.stepNumText}>{s.num}</Text></View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.stepTitle}>{s.title}</Text>
                  <Text style={styles.stepDesc}>{s.desc}</Text>
                </View>
              </View>
            ))}
            <View style={[styles.howtoCard, { backgroundColor: '#fffbeb', borderColor: '#fcd34d' }]}>
              <Text style={[styles.howtoCardTitle, { color: '#78350f', marginBottom: 6 }]}>💡 ヒント：問題ヘッダーの見方</Text>
              <Text style={[styles.howtoCardDesc, { color: '#92400e' }]}>{'画面上部のヘッダーには科目名・トピック・出題年度が表示されます。\n「要復習」バッジが付いている問題はまだ身についていない問題です。意識して取り組みましょう。'}</Text>
            </View>
            <View style={[styles.howtoCard, { marginTop: 16 }]}>
              <Text style={[styles.howtoCardTitle, { marginBottom: 10 }]}>ヤリコミ度のランクについて</Text>
              <Text style={{ fontSize: 12, color: COLORS.subtext, marginBottom: 12 }}>各問題は連続正解数に応じて4段階のランクに分かれ、それが「ヤリコミ度」タブのグラフに反映されます。</Text>
              {[
                { label: '初級', color: COLORS.danger, desc: 'まだ要復習中の問題（不正解、または正解が1回のみ）' },
                { label: '中級', color: '#EF9F27', desc: '2回連続で正解した問題' },
                { label: '上級', color: COLORS.primary, desc: '3回連続で正解した問題' },
                { label: 'マスター', color: COLORS.success, desc: '4回以上連続で正解した問題' },
              ].map((r) => (
                <View key={r.label} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                  <View style={{ width: 56, paddingVertical: 4, borderRadius: 8, backgroundColor: r.color + '1A', alignItems: 'center' }}>
                    <Text style={{ fontSize: 12, fontWeight: 'bold', color: r.color }}>{r.label}</Text>
                  </View>
                  <Text style={{ flex: 1, fontSize: 12, color: '#4a5568' }}>{r.desc}</Text>
                </View>
              ))}
            </View>
          </View>
        )}

        {howtoTab === 'tips' && (
          <View>
            <View style={[styles.howtoCard, { marginBottom: 16 }]}>
              <Text style={[styles.howtoCardTitle, { marginBottom: 10 }]}>7科目の合格ライン目安</Text>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                {SUBJECT_META.map((s) => (
                  <View key={s.key} style={{ flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 10, paddingVertical: 5, borderRadius: 20, backgroundColor: COLORS.primaryLight }}>
                    <Text style={{ fontSize: 12, fontWeight: 'bold', color: COLORS.primary }}>{s.short}</Text>
                  </View>
                ))}
              </View>
              <View style={{ marginTop: 12, flexDirection: 'row', gap: 8 }}>
                <View style={{ flex: 1, backgroundColor: '#fff3cd', padding: 10, borderRadius: 8 }}>
                  <Text style={{ fontSize: 12, fontWeight: 'bold', color: '#7a4a00', marginBottom: 4 }}>合格ライン目安</Text>
                  <Text style={{ fontSize: 18, fontWeight: 'bold', color: '#EF9F27' }}>各科目 60%</Text>
                </View>
                <View style={{ flex: 1, backgroundColor: '#fee2e2', padding: 10, borderRadius: 8 }}>
                  <Text style={{ fontSize: 12, fontWeight: 'bold', color: '#7f1d1d', marginBottom: 4 }}>足切りライン</Text>
                  <Text style={{ fontSize: 18, fontWeight: 'bold', color: '#e74c3c' }}>1科目 40%未満</Text>
                </View>
              </View>
            </View>
            {tips.map((tip) => (
              <View key={tip.title} style={{ borderLeftWidth: 4, borderLeftColor: tip.color, borderRadius: 6, padding: 14, marginBottom: 12, backgroundColor: tip.color + '12' }}>
                <Text style={{ fontSize: 14, fontWeight: 'bold', color: tip.color, marginBottom: 6 }}>{tip.title}</Text>
                <Text style={{ fontSize: 13, color: '#4a5568', lineHeight: 20 }}>{tip.body}</Text>
              </View>
            ))}
            <View style={[styles.howtoCard, { backgroundColor: '#f0fdf4', borderColor: '#bbf7d0' }]}>
              <Text style={[styles.howtoCardTitle, { color: '#166534', marginBottom: 12 }]}>🏆 推奨学習フロー</Text>
              {[
                { phase: '序盤', color: COLORS.primary, text: 'ランダム練習で全科目の傾向をつかむ' },
                { phase: '中盤', color: '#EF9F27', text: '弱い科目はトピック別で集中強化。進捗率タブで状況確認' },
                { phase: '直前', color: '#e74c3c', text: '要復習の問題を繰り返し解いて弱点をつぶす' },
              ].map((f) => (
                <View key={f.phase} style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10, marginBottom: 10 }}>
                  <View style={{ paddingHorizontal: 10, paddingVertical: 3, borderRadius: 12, backgroundColor: f.color }}>
                    <Text style={{ fontSize: 12, fontWeight: 'bold', color: 'white' }}>{f.phase}</Text>
                  </View>
                  <Text style={{ flex: 1, fontSize: 13, color: '#2d7a3e', lineHeight: 20, paddingTop: 2 }}>{f.text}</Text>
                </View>
              ))}
            </View>
          </View>
        )}

        <TouchableOpacity style={[styles.backBtn, { marginTop: 16 }]} onPress={() => setScreen('hub')}>
          <Text style={styles.backBtnText}>← 戻る</Text>
        </TouchableOpacity>
      </ScrollView>
    );
  }

  // ── みんなの学習ランキング ──────────────────────────
  // アカウント登録不要・匿名deviceId＋任意ニックネームのみで参加できる、
  // 「直近7日間の解答数」による気軽なランキング。正答率ではなく解答量を
  // 指標にすることで、間違いを恐れず取り組めるようにしている。
  if (screen === 'ranking') {
    const myWeeklyCount = computeWeeklyAnsweredCount(dailyLog);
    const myEntry = leaderboard.find((e) => e.deviceId === rankingDeviceId);

    return (
      <ScrollView style={styles.container} contentContainerStyle={{ paddingBottom: 140 }}>
        <Text style={styles.title}>みんなの学習ランキング</Text>
        <Text style={styles.subtitle}>直近7日間の解答数ランキング（匿名参加）</Text>

        <View style={styles.card}>
          <Text style={{ fontSize: 13, fontWeight: 'bold', color: '#2c3e50', marginBottom: 8 }}>表示用ニックネーム</Text>
          <TextInput
            value={rankingNickname}
            onChangeText={updateRankingNickname}
            placeholder="名無しさん"
            maxLength={20}
            style={{ borderWidth: 1, borderColor: COLORS.border, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8, fontSize: 14, color: '#2c3e50' }}
          />
          <Text style={{ fontSize: 11, color: COLORS.subtext, marginTop: 6 }}>
            本名やメールアドレスなど、個人が特定できる情報は入力しないでください。
          </Text>

          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 14, paddingTop: 14, borderTopWidth: 1, borderTopColor: '#f0f0f0' }}>
            <View>
              <Text style={{ fontSize: 12, color: COLORS.subtext }}>あなたの直近7日間</Text>
              <Text style={{ fontSize: 22, fontWeight: 'bold', color: COLORS.primary }}>{myWeeklyCount}問</Text>
            </View>
            {myEntry && (
              <View style={{ alignItems: 'flex-end' }}>
                <Text style={{ fontSize: 12, color: COLORS.subtext }}>現在の順位</Text>
                <Text style={{ fontSize: 22, fontWeight: 'bold', color: '#EF9F27' }}>{myEntry.rank}位</Text>
              </View>
            )}
          </View>
        </View>

        <TouchableOpacity
          style={[styles.menuBtn, { alignItems: 'center', opacity: rankingLoading ? 0.6 : 1 }]}
          onPress={refreshRanking}
          disabled={rankingLoading}
        >
          <Text style={{ fontSize: 14, fontWeight: 'bold', color: COLORS.primary }}>
            {rankingLoading ? '更新中…' : '↻ 最新のランキングを取得'}
          </Text>
        </TouchableOpacity>

        {!!rankingError && (
          <View style={{ backgroundColor: '#fee2e2', borderRadius: 8, padding: 12, marginTop: 12 }}>
            <Text style={{ fontSize: 12, color: '#7f1d1d' }}>{rankingError}</Text>
          </View>
        )}

        {leaderboard.length > 0 && (
          <View style={[styles.card, { marginTop: 16 }]}>
            <Text style={{ fontSize: 13, fontWeight: 'bold', color: '#2c3e50', marginBottom: 10 }}>
              上位{leaderboard.length}件（参加者数：{leaderboardTotal}人）
            </Text>
            {leaderboard.map((entry) => {
              const isMe = entry.deviceId === rankingDeviceId;
              return (
                <View
                  key={entry.deviceId}
                  style={{
                    flexDirection: 'row', alignItems: 'center', paddingVertical: 8,
                    borderBottomWidth: 1, borderBottomColor: '#f0f0f0',
                    backgroundColor: isMe ? COLORS.primaryLight : 'transparent',
                    borderRadius: isMe ? 6 : 0, paddingHorizontal: isMe ? 8 : 0,
                  }}
                >
                  <Text style={{ width: 40, fontSize: 14, fontWeight: 'bold', color: entry.rank <= 3 ? '#EF9F27' : '#718096' }}>
                    {entry.rank}位
                  </Text>
                  <Text style={{ flex: 1, fontSize: 14, color: '#2c3e50', fontWeight: isMe ? 'bold' : 'normal' }} numberOfLines={1}>
                    {entry.nickname}{isMe ? '（あなた）' : ''}
                  </Text>
                  <Text style={{ fontSize: 14, fontWeight: 'bold', color: COLORS.primary }}>{entry.weeklyCount}問</Text>
                </View>
              );
            })}
          </View>
        )}

        <TouchableOpacity style={[styles.backBtn, { marginTop: 16 }]} onPress={() => setScreen('hub')}>
          <Text style={styles.backBtnText}>← 戻る</Text>
        </TouchableOpacity>
      </ScrollView>
    );
  }

  // トピック選択
  if (screen === 'practice_subject_select') {
    return (
      <ScrollView style={styles.container} contentContainerStyle={{ paddingBottom: 140 }}>
        <Text style={styles.title}>練習問題</Text>
        <Text style={styles.subtitle}>科目を選択してください</Text>

        {renderQuizCountPicker(STANDALONE_QUESTIONS.length)}

        <TouchableOpacity style={styles.menuBtn} onPress={startRandomPractice}>
          <View style={styles.menuBtnRow}>
            <MenuIconBox name="shuffle" />
            <View style={{ flex: 1 }}>
              <Text style={styles.menuBtnTitle}>全科目からランダム</Text>
              <Text style={styles.menuBtnDesc}>全科目・全年度から選んだ問題数をランダムに出題</Text>
            </View>
          </View>
        </TouchableOpacity>

        {SUBJECT_META.map(({ key: subject }) => {
          const counts = SUBJECT_TYPE_QUESTION_COUNTS[subject] ?? { text: 0, image: 0, total: 0 };
          return (
            <TouchableOpacity key={subject} style={styles.menuBtn} onPress={() => { setPracticeSubject(subject); setScreen('practice_mode_select'); }}>
              <View style={styles.menuBtnRow}>
                <MenuIconBox name="book" />
                <View style={{ flex: 1 }}>
                  <Text style={styles.menuBtnTitle}>{subject}</Text>
                  <Text style={styles.menuBtnDesc}>{counts.total}問収録</Text>
                </View>
              </View>
            </TouchableOpacity>
          );
        })}
        <TouchableOpacity style={styles.backBtn} onPress={() => setScreen('hub')}>
          <Text style={styles.backBtnText}>← 戻る</Text>
        </TouchableOpacity>
      </ScrollView>
    );
  }

  if (screen === 'practice_mode_select' && practiceSubject) {
    const counts = SUBJECT_TYPE_QUESTION_COUNTS[practiceSubject] ?? { text: 0, material: 0, image: 0, total: 0 };
    const allModes: { type: 'text' | 'material' | 'image' | 'random' | 'weak'; label: string; desc: string; count: number; icon: IconName }[] = [
      { type: 'text', label: '文章問題', desc: '資料や図表を含まない問題のみ出題', count: counts.text, icon: 'edit' },
      { type: 'material', label: '資料読解問題', desc: '統計表・条文引用など資料を読んで解く問題のみ出題', count: counts.material, icon: 'book' },
      { type: 'image', label: '図問題', desc: '図表・グラフを含む問題のみ出題', count: counts.image, icon: 'chart' },
      { type: 'random', label: 'ランダム問題', desc: '3タイプを区別せず出題', count: counts.total, icon: 'shuffle' },
      { type: 'weak', label: '弱点重点', desc: 'この科目の中で、苦手なトピック・間違えた問題ほど優先的に出題', count: counts.total, icon: 'target' },
    ];
    const modeOptions = allModes.filter((m) => m.count > 0);
    return (
      <ScrollView style={styles.container} contentContainerStyle={{ paddingBottom: 140 }}>
        <Text style={styles.title}>{practiceSubject}</Text>
        <Text style={styles.subtitle}>出題数と出題タイプを選択してください</Text>
        {renderQuizCountPicker(counts.total, false)}
        {modeOptions.map((m) => (
          <TouchableOpacity key={m.type} style={styles.menuBtn} onPress={() => startQuizBySubjectAndType(practiceSubject, m.type)}>
            <View style={styles.menuBtnRow}>
              <MenuIconBox name={m.icon} />
              <View style={{ flex: 1 }}>
                <Text style={styles.menuBtnTitle}>{m.label}</Text>
                <Text style={styles.menuBtnDesc}>{m.desc}（{m.count}問）</Text>
              </View>
            </View>
          </TouchableOpacity>
        ))}
        <TouchableOpacity style={styles.backBtn} onPress={() => setScreen('practice_subject_select')}>
          <Text style={styles.backBtnText}>← 科目選択に戻る</Text>
        </TouchableOpacity>
      </ScrollView>
    );
  }

  if (screen === 'topic_select') {
    return (
      <ScrollView style={styles.container} contentContainerStyle={{ paddingBottom: 140 }}>
        <Text style={styles.title}>トピック別学習</Text>
        <Text style={styles.subtitle}>科目を選択してください</Text>
        {SUBJECT_META.map(({ key: subject }) => (
          <TouchableOpacity key={subject} style={styles.menuBtn} onPress={() => { setTopicSubject(subject); setScreen('topic_list'); }}>
            <View style={styles.menuBtnRow}>
              <MenuIconBox name="target" />
              <View style={{ flex: 1 }}>
                <Text style={styles.menuBtnTitle}>{subject}</Text>
                <Text style={styles.menuBtnDesc}>{(SUBJECT_TOPIC_LIST[subject] ?? []).length}トピック</Text>
              </View>
            </View>
          </TouchableOpacity>
        ))}
        <TouchableOpacity style={styles.backBtn} onPress={() => setScreen('hub')}>
          <Text style={styles.backBtnText}>← 戻る</Text>
        </TouchableOpacity>
      </ScrollView>
    );
  }

  if (screen === 'topic_list' && topicSubject) {
    const topics = SUBJECT_TOPIC_LIST[topicSubject] || [];
    return (
      <ScrollView style={styles.container} contentContainerStyle={{ paddingBottom: 140 }}>
        <Text style={styles.title}>{topicSubject}</Text>
        <Text style={styles.subtitle}>出題数とトピックを選択してください</Text>
        {renderQuizCountPicker(Math.max(...topics.map((tp) => SUBJECT_TOPIC_QUESTION_COUNTS[topicSubject]?.[tp] ?? 0), 0), false)}
        {topics.map((topic) => {
          const count = SUBJECT_TOPIC_QUESTION_COUNTS[topicSubject]?.[topic] ?? 0;
          const tier = SUBJECT_TOPIC_IMPORTANCE[topicSubject]?.[topic];
          // ── 弱点診断の可視化：この単元の習得率をバッジ表示 ──────────
          // topicMasteryRateMemoは元々おまかせ出題の重み付け計算専用に
          // 使われていたが、ユーザーには一切見えていなかった。
          // サンプル数3問未満は「判断材料が不足」として非表示にする
          // （computeSmartScoreの弱点判定と同じ閾値に揃えている）。
          const topicBucket = topicMasteryRateMemo[`${topicSubject}__${topic}`];
          const topicRate = topicBucket && topicBucket.answered >= 3
            ? Math.round((topicBucket.masteredCount / topicBucket.answered) * 100)
            : null;
          return (
            <TouchableOpacity key={topic} style={styles.menuBtn} onPress={() => startQuizByTopic(topicSubject, topic)}>
              <Text style={styles.menuBtnTitle}>{topic}</Text>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14, marginTop: 4, flexWrap: 'wrap' }}>
                {tier && (
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                    <Text style={{ fontSize: 11, color: COLORS.subtext }}>重要度</Text>
                    <ImportanceStars tier={tier} />
                  </View>
                )}
                <Text style={styles.menuBtnDesc}>{count > 0 ? `${count}問収録` : '準備中（科目全体からランダム出題）'}</Text>
                {topicRate !== null && (
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                    <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: barColor(topicRate) }} />
                    <Text style={{ fontSize: 11, fontWeight: 'bold', color: barColor(topicRate) }}>習得率 {topicRate}%</Text>
                  </View>
                )}
              </View>
            </TouchableOpacity>
          );
        })}
        <TouchableOpacity style={styles.backBtn} onPress={() => setScreen('topic_select')}>
          <Text style={styles.backBtnText}>← 科目選択に戻る</Text>
        </TouchableOpacity>
      </ScrollView>
    );
  }

  // 単語学習：科目選択
  if (screen === 'vocab') {
    return (
      <ScrollView style={styles.container} contentContainerStyle={{ paddingBottom: 140 }}>
        <Text style={styles.title}>単語学習</Text>
        <Text style={styles.subtitle}>フラッシュカードで重要用語を暗記しましょう</Text>

        <TouchableOpacity style={[styles.menuBtn, styles.reviewBtn]} onPress={startVocabReview}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
            <View style={{ flex: 1 }}>
              <Text style={[styles.menuBtnTitle, { color: '#c0392b' }]}>間違い単語を復習</Text>
              <Text style={styles.menuBtnDesc}>{wrongWordIds.size > 0 ? `${wrongWordIds.size}語が復習待ちです` : 'まだ「まだ」を選んだ単語はありません'}</Text>
            </View>
            {wrongWordIds.size > 0 && (
              <View style={styles.wrongBadge}><Text style={styles.wrongBadgeText}>{wrongWordIds.size}</Text></View>
            )}
          </View>
        </TouchableOpacity>

        <Text style={{ fontSize: 12, color: COLORS.subtext, fontWeight: 'bold', marginTop: 8, marginBottom: 10 }}>科目を選択してください</Text>
        {SUBJECT_META.map((sub) => {
          const count = (VOCAB_DATA[sub.key] ?? []).length;
          const isReady = count > 0;
          return (
            <TouchableOpacity key={sub.key} style={[styles.menuBtn, !isReady && { opacity: 0.55 }]} onPress={() => startVocabRandom(sub.key)}>
              <View style={styles.menuBtnRow}>
                <MenuIconBox name="cards" />
                <View style={{ flex: 1 }}>
                  <Text style={styles.menuBtnTitle}>{sub.key}</Text>
                  <Text style={styles.menuBtnDesc}>{isReady ? `${count}語収録` : '準備中'}</Text>
                </View>
              </View>
            </TouchableOpacity>
          );
        })}

        <TouchableOpacity style={styles.backBtn} onPress={() => setScreen('hub')}>
          <Text style={styles.backBtnText}>← 練習問題に戻る</Text>
        </TouchableOpacity>
      </ScrollView>
    );
  }

 // 単語学習：フラッシュカード
  if (screen === 'vocab_card') {
    return <VocabCardScreen />;
  }
  // 単語学習：完了画面
  if (screen === 'vocab_complete') {
    const total = vocabKnownCount + vocabUnknownCount;
    const rate = total > 0 ? Math.round((vocabKnownCount / total) * 100) : 0;
    return (
      <ScrollView style={styles.container} contentContainerStyle={{ paddingBottom: 140 }}>
        <Text style={styles.title}>学習完了！</Text>
        <Text style={styles.subtitle}>{vocabSubject}</Text>

        <View style={{ backgroundColor: 'white', borderRadius: 16, padding: 24, alignItems: 'center', borderWidth: 1, borderColor: COLORS.border, marginBottom: 20 }}>
          <Text style={{ fontSize: 13, color: COLORS.subtext, marginBottom: 6 }}>覚えた割合</Text>
          <Text style={{ fontSize: 40, fontWeight: 'bold', color: rate >= 70 ? '#2ecc71' : rate >= 40 ? '#EF9F27' : '#e74c3c' }}>{rate}%</Text>
          <View style={{ flexDirection: 'row', gap: 16, marginTop: 16 }}>
            <View style={{ alignItems: 'center' }}>
              <Text style={{ fontSize: 22, fontWeight: 'bold', color: '#2ecc71' }}>{vocabKnownCount}</Text>
              <Text style={{ fontSize: 12, color: COLORS.subtext }}>✓ 覚えた</Text>
            </View>
            <View style={{ alignItems: 'center' }}>
              <Text style={{ fontSize: 22, fontWeight: 'bold', color: '#e74c3c' }}>{vocabUnknownCount}</Text>
              <Text style={{ fontSize: 12, color: COLORS.subtext }}>✗ まだ</Text>
            </View>
          </View>
        </View>

        {wrongWordIds.size > 0 && (
          <TouchableOpacity style={{ backgroundColor: '#fff0f0', borderRadius: 12, padding: 14, borderWidth: 1, borderColor: '#fca5a5', flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }} onPress={startVocabReview}>
            <View>
              <Text style={{ fontSize: 14, fontWeight: 'bold', color: '#e74c3c' }}>間違い単語を復習する</Text>
              <Text style={{ fontSize: 12, color: COLORS.subtext, marginTop: 2 }}>{wrongWordIds.size}語が復習待ちです</Text>
            </View>
            <Text style={{ fontSize: 20, color: '#e74c3c' }}>›</Text>
          </TouchableOpacity>
        )}

        {/* ── ②startVocabRandomの科目遷移バグを修正 ──────────────
            以前は vocabSubject === '間違い単語復習' の場合に SUBJECT_META[0]
            （経済学・経済政策）へ強制的に飛ばしてしまっていた。
            vocabMode を見て「復習の続き」か「同じ科目をもう一度」かを
            正しく出し分けるように修正。 */}
        <TouchableOpacity
          style={styles.menuBtn}
          onPress={() => {
            if (vocabMode === 'review') {
              startVocabReview();
            } else if (vocabSubject) {
              startVocabRandom(vocabSubject);
            }
          }}
        >
          <Text style={styles.menuBtnTitle}>
            {vocabMode === 'review' ? 'もう一度復習する' : 'もう一度この科目を学習する'}
          </Text>
        </TouchableOpacity>

        <TouchableOpacity style={styles.backBtn} onPress={() => setScreen('vocab')}>
          <Text style={styles.backBtnText}>← 単語学習メニューに戻る</Text>
        </TouchableOpacity>
      </ScrollView>
    );
  }

  // ── 学習結果画面：練習問題を解き終わったら、成績と累計の進捗率を表示する ──
  if (screen === 'result') {
    const sessionRecords = Object.values(answeredRecords);
    const sessionTotal = sessionRecords.length;
    const sessionCorrect = sessionRecords.filter(r => r.isCorrect).length;
    const sessionRate = sessionTotal > 0 ? Math.round((sessionCorrect / sessionTotal) * 100) : 0;

    const resultColor = sessionRate >= 70 ? '#2ecc71' : sessionRate >= 40 ? '#EF9F27' : '#e74c3c';
    const resultMessage =
      sessionRate >= 80 ? 'とてもよくできました！この調子で続けましょう。' :
      sessionRate >= 60 ? 'よくできました。間違えた問題は復習しておきましょう。' :
      sessionRate >= 40 ? 'もう一息です。間違えた問題を中心に復習しましょう。' :
      '焦らず、解説をじっくり読んで理解を深めましょう。';

    return (
      <ScrollView style={styles.container} contentContainerStyle={{ paddingBottom: 140 }}>
        <Text style={styles.title}>お疲れさまでした！</Text>
        <Text style={styles.subtitle}>{selectedSubject}</Text>

        <View style={{ backgroundColor: 'white', borderRadius: 16, padding: 24, alignItems: 'center', borderWidth: 1, borderColor: COLORS.border, marginBottom: 20 }}>
          <Text style={{ fontSize: 13, color: COLORS.subtext, marginBottom: 6 }}>今回の正答率</Text>
          <Text style={{ fontSize: 44, fontWeight: 'bold', color: resultColor }}>{sessionRate}%</Text>
          <Text style={{ fontSize: 13, color: '#4a5568', marginTop: 4 }}>{sessionCorrect} / {sessionTotal} 問正解</Text>
          <Text style={{ fontSize: 13, color: '#4a5568', marginTop: 14, textAlign: 'center', lineHeight: 20 }}>{resultMessage}</Text>
        </View>

        <View style={{ backgroundColor: 'white', borderRadius: 16, padding: 20, borderWidth: 1, borderColor: COLORS.border, marginBottom: 20 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <Text style={{ fontSize: 14, fontWeight: 'bold', color: '#2d3748' }}>全体の習得率</Text>
            <Text style={{ fontSize: 20, fontWeight: 'bold', color: COLORS.primary }}>{masteryRate.toFixed(1)}%</Text>
          </View>
          <View style={{ height: 10, backgroundColor: '#f1f5f9', borderRadius: 5, overflow: 'hidden' }}>
            <View style={{ width: `${masteryRate}%` as any, height: 10, backgroundColor: COLORS.primary, borderRadius: 5 }} />
          </View>
          <Text style={{ fontSize: 12, color: '#a0aec0', marginTop: 8 }}>
            {MASTERY_STREAK_TARGET}回連続正解で「習得」と判定：{masteredCount} / {TOTAL_PRACTICE_QUESTIONS} 問
          </Text>
        </View>

        {wrongIds.size > 0 && (
          <TouchableOpacity style={{ backgroundColor: '#fff0f0', borderRadius: 12, padding: 14, borderWidth: 1, borderColor: '#fca5a5', flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }} onPress={startReviewWrong}>
            <View>
              <Text style={{ fontSize: 14, fontWeight: 'bold', color: '#e74c3c' }}>要復習</Text>
              <Text style={{ fontSize: 12, color: COLORS.subtext, marginTop: 2 }}>{wrongIds.size}問が復習待ちです</Text>
            </View>
            <Text style={{ fontSize: 20, color: '#e74c3c' }}>›</Text>
          </TouchableOpacity>
        )}

        <TouchableOpacity style={styles.menuBtn} onPress={() => { setMainTab('progress'); setProgressSubTab('analysis'); setScreen('hub'); }}>
          <Text style={styles.menuBtnTitle}>進捗率タブで詳しく見る</Text>
          <Text style={styles.menuBtnDesc}>科目別の正答率や合格ライン達成状況を確認できます</Text>
        </TouchableOpacity>

        <TouchableOpacity style={styles.backBtn} onPress={() => setScreen('hub')}>
          <Text style={styles.backBtnText}>← 練習問題に戻る</Text>
        </TouchableOpacity>
      </ScrollView>
    );
  }

  // 過去問：科目選択（先に科目を選び、次の画面でその科目の年度を複数選ぶ）
  if (screen === 'past') {
    return (
      <ScrollView style={styles.container} contentContainerStyle={{ paddingBottom: 140 }}>
        <Text style={styles.title}>過去問学習モード</Text>
        <Text style={styles.subtitle}>科目を選択してください</Text>
        {SUBJECT_META.map(({ key: subject }) => {
          const years = SUBJECT_YEARS[subject] ?? [];
          if (years.length === 0) return null;
          const total = years.reduce((sum, y) => sum + (YEAR_SUBJECT_QUESTION_COUNTS[y]?.[subject] ?? 0), 0);
          return (
            <TouchableOpacity
              key={subject}
              style={styles.menuBtn}
              onPress={() => { setPastSubject(subject); setPastSelectedYears(years); setScreen('past_years'); }}
            >
              <View style={styles.menuBtnRow}>
                <MenuIconBox name="book" />
                <View style={{ flex: 1 }}>
                  <Text style={styles.menuBtnTitle}>{subject}</Text>
                  <Text style={styles.menuBtnDesc}>{years.length}年度分・{total}問収録</Text>
                </View>
              </View>
            </TouchableOpacity>
          );
        })}
        <TouchableOpacity style={styles.backBtn} onPress={() => setScreen('hub')}>
          <Text style={styles.backBtnText}>← 練習問題に戻る</Text>
        </TouchableOpacity>
      </ScrollView>
    );
  }

  // 過去問：年度（複数選択）・出題数の設定 → スタート
  if (screen === 'past_years' && pastSubject) {
    const years = SUBJECT_YEARS[pastSubject] ?? [];
    const selectedSet = new Set(pastSelectedYears);
    const poolSize = VALID_QUESTIONS.filter(q => (q as any).subject === pastSubject && selectedSet.has((q as any).year)).length;
    const allSelected = years.length > 0 && years.every((y) => selectedSet.has(y));
    const toggleYear = (y: string) =>
      setPastSelectedYears((prev) => (prev.includes(y) ? prev.filter((x) => x !== y) : [...prev, y]));
    const startDisabled = poolSize === 0;
    return (
      <ScrollView style={styles.container} contentContainerStyle={{ paddingBottom: 140 }}>
        <Text style={styles.title}>{pastSubject} 過去問</Text>
        <Text style={styles.subtitle}>出題する年度を選択してください（複数選択できます）</Text>

        <TouchableOpacity
          style={{ alignSelf: 'flex-end', paddingVertical: 6, paddingHorizontal: 12, marginBottom: 8 }}
          onPress={() => setPastSelectedYears(allSelected ? [] : years)}
        >
          <Text style={{ fontSize: 13, fontWeight: 'bold', color: COLORS.primary }}>{allSelected ? '全て解除' : '全て選択'}</Text>
        </TouchableOpacity>

        {years.map((y) => {
          const checked = selectedSet.has(y);
          return (
            <TouchableOpacity
              key={y}
              style={[styles.menuBtn, checked && { borderColor: COLORS.primary, borderWidth: 2 }]}
              onPress={() => toggleYear(y)}
            >
              <View style={styles.menuBtnRow}>
                <View style={{
                  width: 24, height: 24, borderRadius: 6, borderWidth: 2, marginRight: 12,
                  borderColor: checked ? COLORS.primary : '#cbd5e0',
                  backgroundColor: checked ? COLORS.primary : '#fff',
                  alignItems: 'center', justifyContent: 'center',
                }}>
                  {checked && <Text style={{ color: '#fff', fontSize: 14, fontWeight: 'bold' }}>✓</Text>}
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.menuBtnTitle}>{nengo(y)}</Text>
                  <Text style={styles.menuBtnDesc}>{YEAR_SUBJECT_QUESTION_COUNTS[y]?.[pastSubject] ?? 0}問</Text>
                </View>
              </View>
            </TouchableOpacity>
          );
        })}

        <View style={{ marginTop: 8 }}>
          {renderQuizCountPicker(Math.max(poolSize, 1))}
        </View>
        <Text style={{ fontSize: 11, color: COLORS.subtext, marginBottom: 12, lineHeight: 16 }}>
          ※ 「全問」は選んだ年度の順（新しい年度から）・元の出題順で出題します。問題数を絞ると、選んだ年度の中から無作為に出題します（「（設問2）」以降の問題は単独では出題しません）。
        </Text>

        <TouchableOpacity
          style={[styles.smartStartBtn, startDisabled && { opacity: 0.4 }]}
          disabled={startDisabled}
          onPress={() => startPastQuiz(pastSubject, years.filter((y) => selectedSet.has(y)))}
        >
          <Text style={styles.smartStartBtnText}>
            {startDisabled ? '年度を選択してください' : `▶ ${resolveQuizCount(poolSize)}問でスタート（${pastSelectedYears.length}年度）`}
          </Text>
        </TouchableOpacity>

        <TouchableOpacity style={styles.backBtn} onPress={() => setScreen('past')}>
          <Text style={styles.backBtnText}>← 科目選択に戻る</Text>
        </TouchableOpacity>
      </ScrollView>
    );
  }

    // ===== 問題画面 =====
    return <QuestionScreen />;
  };

  return (
    <AppProvider value={contextValue}>
      {renderScreen()}
    </AppProvider>
  );
}

// ── App本体のエクスポート ─────────────────────────────
// screen/mainTabの値に関わらず最前面にトーストを表示できるよう、
// AppInner（元のApp本体）とStorageErrorToastを並べてレンダリングする。
// react-native-safe-area-context の SafeAreaView でラップし、
// iOS・Androidの両方でステータスバーとの重なりを解消する
// （react-native標準のSafeAreaViewはiOSでしか効かないため使用しない）。
// StatusBarのアイコン色は背景が明るい色（#F7F9FC）のため "dark" に固定し、
// 白背景に白アイコンが重なって見えなくなる問題を防ぐ。
export default function App() {
  return (
    <SafeAreaProvider>
      <StatusBar style="dark" />
      <SafeAreaView style={{ flex: 1, backgroundColor: '#f5f7fa' }} edges={['top', 'left', 'right']}>
        <AppInner />
        <StorageErrorToast />
      </SafeAreaView>
    </SafeAreaProvider>
  );
}
