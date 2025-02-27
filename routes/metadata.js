const path = require('path');
const express = require('express');
const router = express.Router();
const { param, query } = require('express-validator');
const db = require('../database/db');
const { getTrackList, toTree } = require('../filesystem/utils');
const { config } = require('../config');
const normalize = require('./utils/normalize');
const { isValidRequest } = require('./utils/validate');

const PAGE_SIZE = config.pageSize || 12;

// GET work cover image
router.get('/cover/:id', param('id').isString(), (req, res, next) => {
  if (!isValidRequest(req, res)) return;

  const rjcode = req.params.id;
  const type = req.query.type || 'main'; // 'main', 'sam', '240x240', '360x360'
  res.sendFile(path.join(config.coverFolderDir, `RJ${rjcode}_img_${type}.jpg`), err => {
    if (err) {
      res.sendFile(path.join(__dirname, '../static/no-image.jpg'), err2 => {
        if (err2) {
          next(err2);
        }
      });
    }
  });
});

// GET work metadata
router.get('/work/RJ:id', param('id').isString(), (req, res, next) => {
  if (!isValidRequest(req, res)) return;

  let username = 'admin';
  if (config.auth) {
    username = req.user.name;
  }
  db.getWorkMetadata(req.params.id, username)
    .then(work => {
      // work is an Array of length 1
      normalize(work);
      res.send(work[0]);
    })
    .catch(err => next(err));
});

// GET track list in work folder
router.get('/tracks/:id', param('id').isInt(), (req, res, next) => {
  if (!isValidRequest(req, res)) return;

  db.knex('t_work')
    .select('title', 'root_folder', 'dir', 'memo')
    .where('id', '=', req.params.id)
    .first()
    .then(work => {
      const rootFolder = config.rootFolders.find(rootFolder => rootFolder.name === work.root_folder);
      if (rootFolder) {
        getTrackList(req.params.id, path.join(rootFolder.path, work.dir), JSON.parse(work.memo))
          .then(tracks => res.send(toTree(tracks, work.title, work.dir, rootFolder)))
          .catch(() => res.status(500).send({ error: '获取文件列表失败，请检查文件是否存在或重新扫描清理' }));
      } else {
        res.status(500).send({ error: `找不到文件夹: "${work.root_folder}"，请尝试重启服务器或重新扫描.` });
      }
    })
    .catch(err => next(err));
});

// GET list of work ids
router.get(
  '/works',
  query('page').optional({ nullable: true }).isInt(),
  query('sort').optional({ nullable: true }).isIn(['desc', 'asc']),
  query('seed').optional({ nullable: true }).isInt(),
  // eslint-disable-next-line no-unused-vars
  async (req, res, next) => {
    if (!isValidRequest(req, res)) return;

    const currentPage = parseInt(req.query.page) || 1;
    // 通过 "音声id, 添加时间, 贩卖日, 评价, 用户评价, 售出数, 评论数量, 价格, 平均评价, 全年龄新作， 评价" 排序
    // ['id', "add_time', 'release', 'rating', 'dl_count', 'review_count', 'price', 'rate_average_2dp, nsfw']
    const order = req.query.order || 'add_time';
    const sort = req.query.sort || 'desc';
    const lyricStatus = JSON.parse(req.query.lyricStatus);
    const pageSize = parseInt(req.query.pageSize) || PAGE_SIZE;
    const offset = (currentPage - 1) * pageSize;
    const username = config.auth ? req.user.name : 'admin';
    const shuffleSeed = req.query.seed ? req.query.seed : 7;

    try {
      const query = () => db.getWorksBy({ username: username });
      let totalCount;
      let works;
      if (lyricStatus) {
        totalCount = await query().where('lyric_status', '=', lyricStatus).count('id as count');
        if (order === 'random') {
          // 随机排序+分页 hack
          works = await query()
            .where('lyric_status', '=', lyricStatus)
            .orderBy(db.knex.raw('id % ?', shuffleSeed))
            .offset(offset)
            .limit(pageSize);
        } else if (order === 'betterRandom') {
          // 随心听专用，不支持分页
          works = await query().where('lyric_status', '=', lyricStatus).orderBy(db.knex.raw('random()')).limit(1);
        } else {
          works = await query()
            .where('lyric_status', '=', lyricStatus)
            .orderBy(order, sort)
            .orderBy([
              { column: 'release', order: 'desc' },
              { column: 'id', order: 'desc' }
            ])
            .offset(offset)
            .limit(pageSize);
        }
      } else {
        totalCount = await query().count('id as count');
        if (order === 'random') {
          // 随机排序+分页 hack
          works = await query().orderBy(db.knex.raw('id % ?', shuffleSeed)).offset(offset).limit(pageSize);
        } else if (order === 'betterRandom') {
          // 随心听专用，不支持分页
          works = await query().orderBy(db.knex.raw('random()')).limit(1);
        } else {
          works = await query()
            .orderBy(order, sort)
            .orderBy([
              { column: 'release', order: 'desc' },
              { column: 'id', order: 'desc' }
            ])
            .offset(offset)
            .limit(pageSize);
        }
      }

      works = normalize(works);

      res.send({
        works,
        page: currentPage,
        pageSize: pageSize,
        totalCount: totalCount[0]['count']
      });
    } catch (err) {
      res.status(500).send({ error: '服务器错误' });
      console.error(err);
      // next(err);
    }
  }
);

// GET name of a circle/tag/VA
router.get('/:field(circle|tag|va)s/:id', param('field').isIn(['circle', 'tag', 'va']), (req, res, next) => {
  // In case regex matching goes wrong
  if (!isValidRequest(req, res)) return;

  return db
    .getMetadata({ field: req.params.field, id: req.params.id })
    .then(item => {
      if (item) {
        res.send(item);
      } else {
        const errorMessage = {
          circle: `社团${req.params.id}不存在`,
          tag: `标签${req.params.id}不存在`,
          va: `声优${req.params.id}不存在`
        };
        res.status(404).send({ error: errorMessage[req.params.field] });
      }
    })
    .catch(err => next(err));
});

// eslint-disable-next-line no-unused-vars
router.get('/search', async (req, res, next) => {
  const keywords = req.query.keywords;
  const currentPage = parseInt(req.query.page) || 1;
  // 通过 "音声id, 贩卖日, 用户评价， 售出数, 评论数量, 价格, 平均评价, 全年龄新作" 排序
  // ['id', 'release', 'rating', 'dl_count', 'review_count', 'price', 'rate_average_2dp', 'nsfw']
  const order = req.query.order || 'release';
  const sort = req.query.sort || 'desc';
  const lyricStatus = JSON.parse(req.query.lyricStatus);
  const pageSize = parseInt(req.query.pageSize) || PAGE_SIZE;
  const offset = (currentPage - 1) * pageSize;
  const username = config.auth ? req.user.name : 'admin';
  const shuffleSeed = req.query.seed ? req.query.seed : 7;

  try {
    const query = () => db.getWorksByKeyWord({ keywords: keywords, username: username });
    let totalCount;
    let works;
    if (lyricStatus) {
      totalCount = await query().where('lyric_status', '=', lyricStatus).count('id as count');
      if (order === 'random') {
        works = await query()
          .where('lyric_status', '=', lyricStatus)
          .offset(offset)
          .limit(pageSize)
          .orderBy(db.knex.raw('id % ?', shuffleSeed));
      } else {
        works = await query()
          .where('lyric_status', '=', lyricStatus)
          .offset(offset)
          .limit(pageSize)
          .orderBy(order, sort)
          .orderBy([
            { column: 'release', order: 'desc' },
            { column: 'id', order: 'desc' }
          ]);
      }
    } else {
      totalCount = await query().count('id as count');
      if (order === 'random') {
        works = await query().offset(offset).limit(pageSize).orderBy(db.knex.raw('id % ?', shuffleSeed));
      } else {
        works = await query()
          .offset(offset)
          .limit(pageSize)
          .orderBy(order, sort)
          .orderBy([
            { column: 'release', order: 'desc' },
            { column: 'id', order: 'desc' }
          ]);
      }
    }

    works = normalize(works);

    res.send({
      works,
      page: currentPage,
      pageSize: pageSize,
      totalCount: totalCount[0]['count']
    });
  } catch (err) {
    res.status(500).send({ error: '查询过程中出错' });
    console.error(err);
    next(err);
  }
});

// GET list of circles/tags/VAs
router.get('/:field(circle|tag|va)s/', param('field').isIn(['circle', 'tag', 'va']), (req, res, next) => {
  // In case regex matching goes wrong
  if (!isValidRequest(req, res)) return;

  const field = req.params.field;
  db.getLabels(field)
    .orderBy(`name`, 'asc')
    .then(list => res.send(list))
    .catch(err => next(err));
});

module.exports = router;
