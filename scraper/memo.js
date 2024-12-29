const fs = require('fs');
const path = require('path');
const recursiveReaddir = require('recursive-readdir');
const { supportedMediaExtList, supportedSubtitleExtList, getAudioFileDuration } = require('../filesystem/utils');

const trackFilterRegex = /(SE|se|射精音)(なし|無し|no)/;
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
    // 获取所有文件列表
    const files = await recursiveReaddir(dir);
    const memo = {};
    const trackDuration = [];
    let workDuration = 0.0;
    let lyricStatus = false;

    // 遍历文件并统计信息
    await Promise.all(
      files
        .filter(file => {
          const ext = path.extname(file).toLowerCase();
          if (supportedSubtitleExtList.includes(ext)) {
            lyricStatus = true; // 检查是否包含字幕文件
          }
          return supportedMediaExtList.includes(ext);
        }) // filter
        .map(async file => {
          const shortPath = file.replace(path.join(dir, '/'), '');
          const track = path.dirname(shortPath).toLowerCase();
          const ext = path.extname(shortPath).toLowerCase();
          const title = path.basename(shortPath).toLowerCase().replace(ext, '');

          const oldFileMemo = oldMemo[shortPath];
          const fstat = await fs.promises.stat(file); // 使用异步的 stat 方法
          const newMTime = Math.round(fstat.mtime.getTime());

          // 判断文件是否为新增的
          if (!oldFileMemo || oldFileMemo.mtime !== newMTime) {
            // 添加mtime和duration
            memo[shortPath] = { mtime: newMTime };
            const duration = await getAudioFileDuration(file);
            if (!isNaN(duration) && typeof duration === 'number') {
              memo[shortPath].duration = duration;
            }
            // 输出文件信息
            console.log(`-> [RJ${work_id}] "${shortPath}", (${duration}s), 最新修改: ${fstat.mtime.toLocaleString()}`);
          } else {
            // 使用老的文件信息
            memo[shortPath] = { mtime: oldMemo[shortPath].mtime, duration: oldMemo[shortPath].duration };
          }

          // 存储不匹配的文件夹及其所有文件播放时长信息
          if (!trackFilterRegex.test(track)) {
            trackDuration.push({ track, title, duration: memo[shortPath].duration });
          }
        }) // map
    ); // Promise.all

    // 根据文件名去重，避免重复计算相同的标题
    const uniqueTitle = new Map();

    trackDuration.forEach(item => {
      if (!uniqueTitle.has(item.title)) {
        uniqueTitle.set(item.title, item);
        workDuration += item.duration;
      }
    });

    // 四舍五入播放时长
    workDuration = Math.round(workDuration);

    return { workDuration, memo, lyricStatus };
  } catch (err) {
    console.error(`Error processing work [RJ${work_id}]:`, err);
    throw err; // 如果有任何错误，抛出错误
  }
};

module.exports = { scrapeWorkMemo };
