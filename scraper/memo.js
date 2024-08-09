const fs = require("fs");
const path = require("path");
const recursiveReaddir = require("recursive-readdir");
const { supportedMediaExtList, supportedSubtitleExtList, getAudioFileDuration } = require("../filesystem/utils");

/**
 * 从文件系统，抓取单个作品本地文件的杂项信息
 * TODO: 文件hash
 * @param {string} work_id 作品RJ号
 * @param {string} dir 作品本地文件夹路径
 * @param {object} oldMemo 旧版本本地文件信息
 * @returns {
 * duration: {"relative/path/to/audio1.mp3": 334.23, ...},
 * isContainLyric: boolean,
 * mtime: {"relative/path/to/audio1.mp3": 1704972508000, ...}
 * }
 */
async function scrapeWorkMemo(work_id, dir, oldMemo) {
  const files = await recursiveReaddir(dir);
  // Filter out any files not matching these extensions
  const oldMemoMtime = oldMemo.mtime || {};
  const oldMemoDuration = oldMemo.duration || {};
  const memo = { duration: {}, isContainLyric: false, mtime: {} };
  let trackInfo = [];
  let workDuration = 0.0;
  await Promise.all(
    files
      .filter((file) => {
        const ext = path.extname(file).toLowerCase();
        // TODO: 添加歌词字幕
        // if (supportedSubtitleExtList.includes(ext)) {
        //   memo.isContainLyric = true;
        // }
        return supportedMediaExtList.includes(ext);
      }) // filter
      .map((file) => ({
        fullPath: file,
        shortPath: file.replace(path.join(dir, "/"), ""),
      })) // map
      .map(async (fileDict) => {
        const fstat = fs.statSync(fileDict.fullPath);
        const newMTime = Math.round(fstat.mtime.getTime());
        const oldMTime = oldMemoMtime[fileDict.shortPath];
        const oldDuration = oldMemoDuration[fileDict.shortPath];

        if (
          oldMTime === undefined || // 音频文件是新增的
          oldDuration === undefined || // 此前没有更新过这个文件的duration
          oldMTime !== newMTime // 或者音频文件的最后修改时间和之前的memo记录不一致，说明文件有修改
        ) {
          // 更新duration和mtime
          console.log(`[RJ${work_id}] update data on file: ${fileDict.fullPath}, fs.mtime: ${fstat.mtime.getTime()}`);
          memo.mtime[fileDict.shortPath] = newMTime;
          const duration = await getAudioFileDuration(fileDict.fullPath);
          if (!isNaN(duration) && typeof duration === "number") {
            memo.duration[fileDict.shortPath] = duration;
          }
        } else {
          // 使用老的文件信息
          memo.mtime[fileDict.shortPath] = oldMTime;
          memo.duration[fileDict.shortPath] = oldDuration;
        }
        // 统计全部音频中不重复的播放时长
        const track = path.dirname(fileDict.shortPath);
        const ext = path.extname(fileDict.shortPath);
        const title = path.basename(fileDict.shortPath).replace(ext, "");
        trackInfo.push({ track: track, title: title, duration: memo.duration[fileDict.shortPath], ext: ext });
      }) // map get duration
  ); // Promise.all

  // 根据标题、播放时长去重，计算作品播放时长
  const res = new Map();
  trackInfo = trackInfo.filter((item) => !res.has(item["title"]) && res.set(item["title"], 1));
  trackInfo = trackInfo.filter((item) => !res.has(item["duration"]) && res.set(item["duration"], 1));
  trackInfo.map((track) => { workDuration += track.duration });

  return { workDuration, memo };
}

module.exports = { scrapeWorkMemo };
