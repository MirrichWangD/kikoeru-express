const express = require('express');
const router = express.Router();
const { config } = require('../config');
const db = require('../database/db');
const { param } = require('express-validator');
const fs = require('fs');
const path = require('path');
const jschardet = require('jschardet');
const { getTrackList, supportedSubtitleExtList } = require('../filesystem/utils');
const { joinFragments } = require('./utils/url');
const { isValidRequest } = require('./utils/validate');

// GET (stream) a specific track from work folder
router.get('/stream/RJ:id/:trackFile([\\s\\S]*)', param('id').isInt(), (req, res, next) => {
  if (!isValidRequest(req, res)) return;

  db.knex('t_work')
    .select('root_folder', 'dir')
    .where('id', '=', req.params.id)
    .first()
    .then(work => {
      const rootFolder = config.rootFolders.find(rootFolder => rootFolder.name === work.root_folder);
      if (rootFolder) {
        getTrackList(req.params.id, path.join(rootFolder.path, work.dir))
          .then(tracks => {
            const track = tracks.find(track => track.mediaPath === `RJ${req.params.id}/${req.params.trackFile}`);

            const fileName = path.join(rootFolder.path, work.dir, track.subtitle || '', track.title);
            const extName = path.extname(fileName);
            if ((supportedSubtitleExtList + ['.txt']).includes(extName)) {
              const fileBuffer = fs.readFileSync(fileName);
              const charsetMatch = jschardet.detect(fileBuffer).encoding;
              if (charsetMatch) {
                res.setHeader('Content-Type', `text/plain; charset=${charsetMatch}`);
              }
            }
            if (extName === '.flac') {
              // iOS不支持audio/x-flac
              res.setHeader('Content-Type', `audio/flac`);
            }

            // Offload from express, 302 redirect to a virtual directory in a reverse proxy like Nginx
            // Only redirect media files, not including text files and lrcs because we need charset detection
            // so that the browser properly renders them
            if (config.offloadMedia && extName !== '.txt' && extName !== '.lrc') {
              // Path controlled by config.offloadMedia and config.offloadStreamPath
              // By default: /media/stream/VoiceWork/RJ123456/subdirs/track.mp3
              // If the folder is deeper: /media/stream/VoiceWork/second/RJ123456/subdirs/track.mp3
              const baseUrl = config.offloadStreamPath;
              let offloadUrl = joinFragments(baseUrl, rootFolder.name, work.dir, track.subtitle || '', track.title);
              if (process.platform === 'win32') {
                offloadUrl = offloadUrl.replace(/\\/g, '/');
              }

              res.redirect(offloadUrl);
            } else {
              // By default, serve file through express
              res.sendFile(fileName);
            }
          })
          .catch(err => next(err));
      } else {
        res.status(500).send({ error: `找不到文件夹: "${work.root_folder}"，请尝试重启服务器或重新扫描.` });
      }
    })
    .catch(err => next(err));
});

router.get('/download/RJ:id/:trackFile([\\s\\S]*)', param('id').isInt(), (req, res, next) => {
  if (!isValidRequest(req, res)) return;

  db.knex('t_work')
    .select('root_folder', 'dir')
    .where('id', '=', req.params.id)
    .first()
    .then(work => {
      const rootFolder = config.rootFolders.find(rootFolder => rootFolder.name === work.root_folder);
      if (rootFolder) {
        getTrackList(req.params.id, path.join(rootFolder.path, work.dir))
          .then(tracks => {
            const track = tracks.find(track => track.mediaPath === `RJ${req.params.id}/${req.params.trackFile}`);

            // Offload from express, 302 redirect to a virtual directory in a reverse proxy like Nginx
            if (config.offloadMedia) {
              // Path controlled by config.offloadMedia and config.offloadDownloadPath
              // By default: /media/download/VoiceWork/RJ123456/subdirs/track.mp3
              // If the folder is deeper: /media/download/VoiceWork/second/RJ123456/subdirs/track.mp3
              const baseUrl = config.offloadDownloadPath;
              let offloadUrl = joinFragments(baseUrl, rootFolder.name, work.dir, track.subtitle || '', track.title);
              if (process.platform === 'win32') {
                offloadUrl = offloadUrl.replace(/\\/g, '/');
              }

              // Note: you should set 'Content-Disposition: attachment' header in your reverse proxy for the download virtual directory
              // By default the directory is /media/download
              res.redirect(offloadUrl);
            } else {
              // By default, serve file through express
              res.download(path.join(rootFolder.path, work.dir, track.subtitle || '', track.title));
            }
          })
          .catch(err => next(err));
      } else {
        res.status(500).send({ error: `找不到文件夹: "${work.root_folder}"，请尝试重启服务器或重新扫描.` });
      }
    });
});

router.get('/check-lrc/:id/:index', param('id').isInt(), param('index').isInt(), (req, res, next) => {
  if (!isValidRequest(req, res)) return;

  db.knex('t_work')
    .select('root_folder', 'dir', 'lyric_status')
    .where('id', '=', req.params.id)
    .first()
    .then(work => {
      const rootFolder = config.rootFolders.find(rootFolder => rootFolder.name === work.root_folder);
      if (rootFolder) {
        getTrackList(req.params.id, path.join(rootFolder.path, work.dir))
          .then(tracks => {
            const track = tracks[req.params.index];
            let responseSent = false;

            if (!work.lyric_status) {
              res.send({ result: false, message: '不存在歌词文件', mediaPath: '' });
            } else {
              const lrcFileName = track.title.substring(0, track.title.lastIndexOf('.')) + '.lrc';
              // 文件名、子目录名相同
              tracks.forEach(trackItem => {
                if (trackItem.title === lrcFileName) {
                  res.send({ result: true, message: '找到歌词文件', mediaPath: trackItem.mediaPath });
                  responseSent = true;
                }
              });
              if (!responseSent) {
                res.send({ result: false, message: '该文件不存在歌词文件', mediaPath: '' });
              }
            }
          })
          .catch(err => next(err));
      } else {
        res.status(500).send({ error: `找不到文件夹: "${work.root_folder}"，请尝试重启服务器或重新扫描.` });
      }
    })
    .catch(err => next(err));
});

module.exports = router;
