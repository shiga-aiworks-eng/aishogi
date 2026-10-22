import { GoogleGenAI, Type } from '@google/genai';

export default async function handler(req: any, res: any) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { legalMoves, boardSummary, capturedPieces, moveHistory } = req.body || {};

    if (!legalMoves || !Array.isArray(legalMoves) || legalMoves.length === 0) {
      return res.status(400).json({ error: 'No legal moves provided' });
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return returnFallback(req, res, 'Gemini API Key is not set in Environment Variables');
    }

    const ai = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });

    const systemInstruction = `あなたは将棋を覚えたての初心者を優しく導く親切な将棋の先生（師匠）です。
後手（△白/AI）として、提供された「合法手リスト（legalMoves）」の中から最善と思われる手を1つ選び、JSON形式で返答してください。
また、初心者プレイヤーに向けて、なぜその手を指したのか、盤面の状況やポイントを親しみやすい温かい日本語で1〜2文でアドバイス・解説コメント（comment）として添えてください。
ルール:
必ず提供された合法手リストのインデックス（chosenIndex）を厳密に指定してください。範囲外のインデックスは無効です。`;

    const promptText = `【現在の盤面状態】
${boardSummary || '盤面情報'}

【後手（AI）の持ち駒】
${capturedPieces || 'なし'}

【直近の指し手履歴】
${moveHistory ? moveHistory.slice(-6).join(' → ') : '初手'}

【選択可能な合法手一覧（このインデックスから1つ選択してください）】
${legalMoves
  .map(
    (m: any, idx: number) =>
      `[${idx}] ${m.notation || ''} (${m.type === 'drop' ? `打: ${m.piece} to (${m.to[0]},${m.to[1]})` : `移動: (${m.from[0]},${m.from[1]}) -> (${m.to[0]},${m.to[1]})${m.promote ? ' 成' : ''}`})`
  )
  .join('\n')}

上記の手から最も良い1手をインデックス（0から${legalMoves.length - 1}まで）で選び、初心者への解説コメントと共にJSONで出力してください。`;

    const response = await ai.models.generateContent({
      model: 'gemini-3.8-flash',
      contents: promptText,
      config: {
        systemInstruction,
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            chosenIndex: {
              type: Type.INTEGER,
              description: `合法手リストの中から選択した手の0-indexed番号 (0〜${legalMoves.length - 1})`,
            },
            comment: {
              type: Type.STRING,
              description: '初心者への親しみやすく温かい一言解説・アドバイス (1〜2文)',
            },
          },
          required: ['chosenIndex', 'comment'],
        },
      },
    });

    const parsed = JSON.parse(response.text || '{}');
    const chosenIndex = typeof parsed.chosenIndex === 'number' && parsed.chosenIndex >= 0 && parsed.chosenIndex < legalMoves.length
      ? parsed.chosenIndex
      : 0;

    const chosenMove = legalMoves[chosenIndex];
    return res.status(200).json({
      move: chosenMove,
      comment: parsed.comment || '落ち着いて次の手を考えましょう！',
      source: 'gemini',
    });
  } catch (error: any) {
    console.warn('Gemini API call failed, applying heuristic fallback:', error?.message);
    return returnFallback(req, res, error?.message);
  }
}

function returnFallback(req: any, res: any, reason: string) {
  const legalMoves = req.body?.legalMoves || [];
  if (!legalMoves.length) {
    return res.status(500).json({ error: 'No legal moves', fallbackNeeded: true });
  }

  let bestMove = legalMoves[0];
  let bestScore = -9999;
  legalMoves.forEach((m: any) => {
    let score = Math.random() * 5;
    if (m.promote) score += 20;
    if (m.type === 'move') {
      if (m.to && (m.to[0] === 4 || m.to[1] === 4)) score += 5;
    }
    if (score > bestScore) {
      bestScore = score;
      bestMove = m;
    }
  });

  const comments = [
    '歩を進めて陣形を整えます。序盤は駒の活用が大切ですよ！',
    '駒を前進させて中央の制圧を狙います。慌てず受けてみてくださいね。',
    '角や飛車の利きに注意しながら、じっくり攻めを組み立てましょう。',
    '王様の守りも意識しながら、攻めの隙を伺っています。'
  ];
  const chosenComment = comments[Math.floor(Math.random() * comments.length)];

  return res.status(200).json({
    move: bestMove,
    comment: chosenComment,
    source: 'heuristic-fallback',
    notice: reason,
  });
}
