const fs = require("fs");
const path = require("path");
const recursiveReaddir = require("recursive-readdir");
const { supportedMediaExtList, supportedSubtitleExtList, getAudioFileDuration } = require("../filesystem/utils");

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
const scrapeWorkMemo = async (work_id, dir, oldMemo = {}) => recursiveReaddir(dir)
  .then(async (files) => {
    const memo = {};
    // 统计作品总计播放时长
    const trackDuration = [];
    let workDuration = 0.0;
    // 本地文件夹是否包含字幕文件
    let lyricStatus = false;

    await Promise.all(files
      .filter((file) => {
        const ext = path.extname(file).toLowerCase();
        if (supportedSubtitleExtList.includes(ext)) {
          lyricStatus = true;
        }
        return supportedMediaExtList.includes(ext);
      }) // filter
      .map(async (file) => {
        const shortPath = file.replace(path.join(dir, "/"), "");
        const track = path.dirname(shortPath).toLowerCase();
        const ext = path.extname(shortPath).toLowerCase();
        const title = path.basename(shortPath).toLowerCase().replace(ext, "");

        const oldFileMemo = oldMemo[shortPath];
        const fstat = fs.statSync(file);
        const newMTime = Math.round(fstat.mtime.getTime());

        // 判断文件是否为新增的
        if (oldFileMemo === undefined || oldFileMemo.mtime !== newMTime) {
          // 添加mtime
          memo[shortPath] = { mtime: newMTime };
          // 添加duration
          const duration = await getAudioFileDuration(file);
          if (!isNaN(duration) && typeof duration === "number") {
            memo[shortPath].duration = duration;
          }
          // 输出文件信息
          console.log(`-> [RJ${work_id}] "${shortPath}", (${duration}s), 最新修改: ${fstat.mtime.toLocaleString()}`);
        } else {
          // 使用老的文件信息
          memo[shortPath] = { mtime: oldMemo[shortPath].mtime, duration: oldMemo[shortPath].duration };
        }
        // 存储不匹配 /(SE|se|射精音)(なし|無し|no)/ 字符串的文件夹及其所有文件播放时长信息
        if (!trackFilterRegex.test(track)) {
          trackDuration.push({ track: track, title: title, duration: memo[shortPath].duration });
        }
      }) // map get duration
    ); // Promise.all

    // 根据文件名进行去重，部分作品会同时使用.wav和.mp3格式
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

  })


module.exports = { scrapeWorkMemo };
