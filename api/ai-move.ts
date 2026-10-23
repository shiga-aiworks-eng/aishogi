import { GoogleGenAI, Type, ThinkingLevel } from '@google/genai';

// Vercel serverless execution duration limit (extend up to 30s)
export const maxDuration = 30;

async function getRequestBody(req: any): Promise<any> {
  if (req.body) {
    if (typeof req.body === 'string') {
      try {
        return JSON.parse(req.body);
      } catch {
        return {};
      }
    }
    return req.body;
  }

  // If body parser did not run, read stream
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk: any) => {
      raw += chunk;
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve({});
      }
    });
    req.on('error', () => {
      resolve({});
    });
  });
}

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

  const body = await getRequestBody(req);
  const { legalMoves, boardSummary, capturedPieces, moveHistory, model } = body || {};

  if (!legalMoves || !Array.isArray(legalMoves) || legalMoves.length === 0) {
    return res.status(400).json({ error: 'No legal moves provided' });
  }

  // Allowed models list (Free tier models)
  const allowedModels = ['gemini-3.8-flash', 'gemini-2.5-flash', 'gemini-3.1-flash-lite'];
  const selectedModel = allowedModels.includes(model) ? model : 'gemini-3.8-flash';

  // Check multiple common environment variable names
  const apiKey =
    process.env.GEMINI_API_KEY ||
    process.env.GOOGLE_API_KEY ||
    process.env.API_KEY ||
    process.env.VITE_GEMINI_API_KEY;

  if (!apiKey) {
    console.warn('Gemini API key is not found in environment variables');
    return returnFallback(body, res, 'APIキー未設定', 'Gemini APIキーがVercelの環境変数に設定されていません');
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

  // Use the selected model
  const modelName = selectedModel;
  let lastError: any = null;

  try {
    const response = await ai.models.generateContent({
      model: modelName,
      contents: promptText,
      config: {
        systemInstruction,
        responseMimeType: 'application/json',
        // Use LOW thinking level for super-fast response within 1-2 seconds (prevents Vercel timeouts)
        thinkingConfig: {
          thinkingLevel: ThinkingLevel.LOW,
        },
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
    const chosenIndex =
      typeof parsed.chosenIndex === 'number' &&
      parsed.chosenIndex >= 0 &&
      parsed.chosenIndex < legalMoves.length
        ? parsed.chosenIndex
        : 0;

    const chosenMove = legalMoves[chosenIndex];
    return res.status(200).json({
      move: chosenMove,
      comment: parsed.comment || '落ち着いて次の手を考えましょう！',
      source: 'gemini',
      modelUsed: modelName,
    });
  } catch (err: any) {
    console.warn(`Model ${modelName} error:`, err?.message);
    lastError = err;
  }

  // Parse specific error category
  const errMsg = String(lastError?.message || '');
  let shortReason = '一時混雑・遅延';
  if (errMsg.includes('503') || errMsg.includes('UNAVAILABLE') || errMsg.includes('demand')) {
    shortReason = 'Google側一時混雑(503)';
  } else if (errMsg.includes('429') || errMsg.includes('RESOURCE_EXHAUSTED') || errMsg.includes('quota')) {
    shortReason = 'API利用制限(429)';
  } else if (errMsg.includes('timeout') || errMsg.includes('504')) {
    shortReason = '応答時間超過(タイムアウト)';
  }

  return returnFallback(body, res, shortReason, errMsg);
}

function returnFallback(body: any, res: any, shortReason: string, rawDetail: string) {
  const legalMoves = body?.legalMoves || [];
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
    '王様の守りも意識しながら、攻めの隙を伺っています。',
  ];
  const chosenComment = comments[Math.floor(Math.random() * comments.length)];

  return res.status(200).json({
    move: bestMove,
    comment: chosenComment,
    source: 'heuristic-fallback',
    fallbackReason: shortReason,
    notice: rawDetail,
  });
}
