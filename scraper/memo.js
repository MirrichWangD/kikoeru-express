const fs = require('fs');
const path = require('path');
const recursiveReaddir = require('recursive-readdir');

const { execFile } = require('child_process');
const { promisify } = require('util');
const execFilePromise = promisify(execFile);

const ffprobeStatic = require('ffprobe-static');
const ffmpeg = require('fluent-ffmpeg');
ffmpeg.setFfprobePath(ffprobeStatic.path);

const { supportedMediaExtList, supportedSubtitleExtList } = require('../filesystem/utils');

const filterRegex = /(なし|無し|no|体験|反転)/;

// 通用的获取文件时长函数
async function getFileDuration(filePath) {
  if (process.pkg) {
    // 在打包环境下使用 execFile
    try {
      const { stdout } = await execFilePromise('ffprobe', [
        '-v',
        'error',
        '-show_entries',
        'format=duration',
        '-of',
        'default=noprint_wrappers=1:nokey=1',
        filePath,
      ]);
      const duration = parseFloat(stdout.trim());
      if (isNaN(duration)) {
        console.error(`Invalid duration for file: ${filePath}`);
        return NaN;
      }
      return duration;
    } catch (err) {
      console.error(`Failed to get duration for file: ${filePath}`, err);
      return NaN;
    }
  } else {
    // 在普通环境下使用 ffmpeg
    return new Promise(resolve => {
      ffmpeg.ffprobe(filePath, (err, metadata) => {
        if (err) {
          console.error(`Error getting duration for file: ${filePath}`, err);
          return resolve(NaN);
        }
        resolve(metadata.format.duration);
      });
    });
  }
}

// 标准化标题字符串，忽略符号差异和格式差异
function normalizeStr(s) {
  return s.toLowerCase().replace(/[♡♪…～・\u3000\s\-]/g, '').normalize('NFKC'); // Unicode标准化，将全角字符转为半角
}

/**
 * 从文件系统，抓取单个作品本地文件的杂项信息
 * TODO: 文件hash
 * @param {string} work_id 作品RJ号
 * @param {string} dir 作品本地文件夹路径
 * @param {object} oldMemo 旧版本本地文件信息
 * @returns {
 *    "relative/path/to/audio1.mp3": {
 *      duration: 334.23,
 *      mtime: 1704972508000
 *    },
 *    ...
 * }
 */
const scrapeWorkMemo = async (work_id, dir, oldMemo = {}) => {
  try {
    const files = await recursiveReaddir(dir);
    const memo = {};
    const trackDuration = [];
    let workDuration = 0.0;
    let lyricStatus = false;

    const fileProcessingPromises = files
      .filter(file => {
        const ext = path.extname(file).toLowerCase();
        if (supportedSubtitleExtList.includes(ext)) {
          lyricStatus = true;
        }
        return supportedMediaExtList.includes(ext);
      })
      .map(async file => {
        const shortPath = file.replace(path.join(dir, '/'), '');
        const ext = path.extname(shortPath).toLowerCase();
        const title = normalizeStr(path.basename(shortPath)).replace(ext, '');

        const oldFileMemo = oldMemo[shortPath];
        const fstat = await fs.promises.stat(file);
        const newMTime = Math.round(fstat.mtime.getTime());

        if (!oldFileMemo || oldFileMemo.mtime !== newMTime || !oldFileMemo.duration) {
          memo[shortPath] = { mtime: newMTime };
          const duration = await getFileDuration(file); // 统一调用获取时长的函数
          if (!isNaN(duration)) {
            memo[shortPath].duration = duration;
            console.log(`-> [RJ${work_id}] "${shortPath}", (${duration}s), 最新修改: ${fstat.mtime.toLocaleString()}`);
          }
        } else {
          memo[shortPath] = { mtime: oldFileMemo.mtime, duration: oldFileMemo.duration };
        }

        if (!filterRegex.test(shortPath.toLowerCase())) {
          trackDuration.push({ title, duration: memo[shortPath].duration });
        }
      });

    // 使用 Promise.all 并行处理所有文件
    await Promise.all(fileProcessingPromises);

    // 去重并计算作品时长
    const uniqueTitle = new Map();
    trackDuration.forEach(item => {
      if (!uniqueTitle.has(item.title)) {
        uniqueTitle.set(item.title, item);
        workDuration += item.duration || 0;
      }
    });
    workDuration = Math.round(workDuration);

    return { workDuration, memo, lyricStatus };
  } catch (err) {
    console.error(`Error processing work [RJ${work_id}]:`, err);
    throw err;
  }
};

module.exports = { scrapeWorkMemo };
