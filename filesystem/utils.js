const fs = require('fs');
const path = require('path');
const recursiveReaddir = require('recursive-readdir');
const { orderBy } = require('natural-orderby');

const { joinFragments } = require('../routes/utils/url');
const { config } = require('../config');

// 日期时间options
const datetimeOptions = {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false
};

// 支持文件后缀类型
// '.ass' only support show on file list, not for play lyric
const supportedSubtitleExtList = ['.lrc', '.srt', '.ass', '.vtt'];
const supportedImageExtList = ['.jpg', '.jpeg', '.png', '.webp'];
const supportedMediaExtList = ['.mp3', '.ogg', '.opus', '.wav', '.aac', '.flac', '.webm', '.mp4', '.m4a', '.mka'];
const supportedExtList = ['txt', 'pdf'] + supportedImageExtList + supportedMediaExtList + supportedSubtitleExtList;

/**
 * Returns list of playable tracks in a given folder. Track is an object
 * containing 'title', 'subtitle' and 'hash'.
 * @param {String} id Work identifier. Currently, RJ/RE code.
 * @param {String} dir Work directory (absolute).
 */
const getTrackList = async (id, dir, readMemo = {}) => {
  const files = await recursiveReaddir(dir);
  const filteredFiles = files.filter(file => {
    const ext = path.extname(file).toLowerCase();

    return supportedExtList.includes(ext);
  });

  // Sort by folder and title
  const sortedFiles = orderBy(
    filteredFiles.map(file => {
      const shortFilePath = file.replace(path.join(dir, '/'), '');
      const dirName = path.dirname(shortFilePath);

      return {
        title: path.basename(file),
        subtitle: dirName === '.' ? null : dirName,
        ext: path.extname(file),
        shortFilePath
      };
    }),
    [v => v.subtitle, v => v.title, v => v.ext]
  );

  // Add hash to each file
  const sortedHashedFiles = sortedFiles.map((file, index) => ({
    title: file.title,
    subtitle: file.subtitle,
    hash: `${id}/${index}`,
    shortFilePath: file.shortFilePath,
    ext: file.ext
  }));

  const memo = readMemo || {};

  // Add 'audio' duration to each file
  sortedHashedFiles.forEach(file => {
    if (supportedMediaExtList.includes(file.ext) && memo[file.shortFilePath] !== undefined) {
      file.duration = memo[file.shortFilePath].duration;
      delete file.shortFilePath;
    }
  });

  return sortedHashedFiles;
};

/**
 * 转换成树状结构
 * @param {Array} tracks
 * @param {String} workTitle
 */
const toTree = (tracks, workTitle, workDir, rootFolder) => {
  const tree = [];

  // 插入文件夹
  tracks.forEach(track => {
    let fatherFolder = tree;
    const trackPath = track.subtitle ? track.subtitle.split(path.sep) : [];

    trackPath.forEach(folderName => {
      let folder = fatherFolder.find(item => item.type === 'folder' && item.title === folderName);
      if (!folder) {
        folder = {
          type: 'folder',
          title: folderName,
          children: []
        };
        fatherFolder.push(folder);
      }
      fatherFolder = folder.children;
    });
  });

  // 插入文件
  tracks.forEach(track => {
    let fatherFolder = tree;
    const trackPath = track.subtitle ? track.subtitle.split(path.sep) : [];
    trackPath.forEach(folderName => {
      fatherFolder = fatherFolder.find(item => item.type === 'folder' && item.title === folderName).children;
    });

    // Path controlled by config.offloadMedia, config.offloadStreamPath and config.offloadDownloadPath
    // If config.offloadMedia is enabled, by default, the paths are:
    // /media/stream/VoiceWork/RJ123456/subdirs/track.mp3
    // /media/download//VoiceWork/RJ123456/subdirs/track.mp3
    //
    // If the folder is deeper:
    // /media/stream/VoiceWork/second/RJ123456/subdirs/track.mp3
    // /media/download/VoiceWork/second/RJ123456/subdirs/track.mp3
    // console.log("track", track);
    let offloadStreamUrl = joinFragments(
      config.offloadStreamPath,
      rootFolder.name,
      workDir,
      track.subtitle || '',
      track.title
    );
    let offloadDownloadUrl = joinFragments(
      config.offloadDownloadPath,
      rootFolder.name,
      workDir,
      track.subtitle || '',
      track.title
    );
    if (process.platform === 'win32') {
      offloadStreamUrl = offloadStreamUrl.replace(/\\/g, '/');
      offloadDownloadUrl = offloadDownloadUrl.replace(/\\/g, '/');
    }

    const textBaseUrl = '/api/media/stream/';
    const mediaStreamBaseUrl = '/api/media/stream/';
    const mediaDownloadBaseUrl = '/api/media/download/';
    const textStreamBaseUrl = textBaseUrl + track.hash; // Handle charset detection internally with jschardet
    const textDownloadBaseUrl = config.offloadMedia ? offloadDownloadUrl : mediaDownloadBaseUrl + track.hash;
    const mediaStreamUrl = config.offloadMedia ? offloadStreamUrl : mediaStreamBaseUrl + track.hash;
    const mediaDownloadUrl = config.offloadMedia ? offloadDownloadUrl : mediaDownloadBaseUrl + track.hash;

    if ((['txt'] + supportedSubtitleExtList).includes(track.ext)) {
      fatherFolder.push({
        type: 'text',
        hash: track.hash,
        title: track.title,
        workTitle,
        mediaStreamUrl: textStreamBaseUrl,
        mediaDownloadUrl: textDownloadBaseUrl
      });
    } else if (supportedImageExtList.includes(track.ext)) {
      fatherFolder.push({
        type: 'image',
        hash: track.hash,
        title: track.title,
        workTitle,
        mediaStreamUrl,
        mediaDownloadUrl
      });
    } else if (track.ext === '.pdf') {
      fatherFolder.push({
        type: 'other',
        hash: track.hash,
        title: track.title,
        workTitle,
        mediaStreamUrl,
        mediaDownloadUrl
      });
    } else {
      fatherFolder.push({
        type: 'audio',
        hash: track.hash,
        title: track.title,
        duration: track.duration,
        workTitle,
        mediaStreamUrl,
        mediaDownloadUrl
      });
    }
  });

  return tree;
};

/**
 * 返回一个成员为指定根文件夹下所有包含 RJ 号的音声文件夹对象的数组，
 * 音声文件夹对象 { relativePath: '相对路径', rootFolderName: '根文件夹别名', id: '音声ID' }
 * @param {Object} rootFolder 根文件夹对象 { name: '别名', path: '绝对路径' }
 */
async function* getFolderList(rootFolder, current = '', depth = 0, callback = function addMainLog() {}) {
  // 异步生成器函数 async function*() {}
  // 浅层遍历
  const folders = await fs.promises.readdir(path.join(rootFolder.path, current));

  for (const folder of folders) {
    const absolutePath = path.resolve(rootFolder.path, current, folder);
    const relativePath = path.join(current, folder);
    const folderInfo = fs.statSync(absolutePath);
    let addTime = folderInfo.birthtime || folderInfo.mtime;
    addTime = addTime.toLocaleString({}, datetimeOptions).replace(/\//g, '-');

    try {
      // eslint-disable-next-line no-await-in-loop
      if ((await fs.promises.stat(absolutePath)).isDirectory()) {
        // 检查是否为文件夹
        if (folder.match(/RJ\d+/)) {
          // 检查文件夹名称中是否含有RJ号
          // Found a work folder, don't go any deeper.
          yield {
            absolutePath,
            relativePath,
            rootFolderName: rootFolder.name,
            addTime: addTime,
            id: folder.match(/RJ(\d+)/)[1]
          };
        } else if (depth + 1 < config.scannerMaxRecursionDepth) {
          // 若文件夹名称中不含有RJ号，就进入该文件夹内部
          // Found a folder that's not a work folder, go inside if allowed.
          yield* getFolderList(rootFolder, relativePath, depth + 1);
        }
      }
    } catch (err) {
      if (err.code === 'EPERM') {
        if (err.path && !err.path.endsWith('System Volume Information')) {
          console.log(' ! 无法访问', err.path);
          callback({
            level: 'info',
            message: ` ! 无法访问 ${err.path}`
          });
        }
      } else {
        throw err;
      }
    }
  }
}

/**
 * Deletes a work's cover image from disk.
 * @param {String} rjcode Work RJ code (only the 6 digits, zero-padded).
 */
const deleteCoverImageFromDisk = rjcode =>
  new Promise((resolve, reject) => {
    const types = ['main', 'sam', '240x240', '360x360'];
    types.forEach(type => {
      try {
        fs.unlinkSync(path.join(config.coverFolderDir, `RJ${rjcode}_img_${type}.jpg`));
      } catch (err) {
        reject(err);
      }
    });

    resolve();
  });

/**
 * Saves cover image to disk.
 * @param {ReadableStream} stream Image data stream.
 * @param {String} rjcode Work RJ code (only the 6 digits, zero-padded).
 * @param {String} types img type: ('main', 'sam', 'sam@2x', 'sam@3x', '240x240', '360x360').
 */
const saveCoverImageToDisk = (stream, rjcode, type) =>
  new Promise((resolve, reject) => {
    // TODO: don't assume image is a jpg?
    try {
      stream.pipe(
        fs
          .createWriteStream(path.join(config.coverFolderDir, `RJ${rjcode}_img_${type}.jpg`))
          .on('close', () => resolve())
      );
    } catch (err) {
      reject(err);
    }
  });

module.exports = {
  getTrackList,
  toTree,
  getFolderList,
  deleteCoverImageFromDisk,
  saveCoverImageToDisk,
  datetimeOptions,
  supportedMediaExtList,
  supportedSubtitleExtList,
  supportedImageExtList,
  supportedExtList
};
