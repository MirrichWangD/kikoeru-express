const fs = require("fs");
const path = require("path");
const LimitPromise = require("limit-promise"); // 限制并发数量

const axios = require("../scraper/axios.js"); // 数据请求
const { scrapeWorkMetadataFromDLsite, scrapeDynamicWorkMetadataFromDLsite } = require("../scraper/dlsite");
const { scrapeWorkMetadataFromAsmrOne } = require("../scraper/asmrOne");

const db = require("../database/db");
const { createSchema } = require("../database/schema");

const { getFolderList, deleteCoverImageFromDisk, saveCoverImageToDisk, getWorkDuration } = require("./utils");
const { md5 } = require("../auth/utils");
const { nameToUUID } = require("../scraper/utils");

const { config } = require("../config");
const { updateLock } = require("../upgrade");

// 只有在子进程中 process 对象才有 send() 方法
process.send = process.send || function () {};

const tasks = [];
const failedTasks = [];
const mainLogs = [];
const results = [];

const logger = {
  finish(message) {
    console.log(` * ${message}`);
    process.send({
      event: "SCAN_FINISHED",
      payload: { message },
    });
  },
  main: {
    __internal__(level, message) {
      console[level](message);

      mainLogs.push({ level, message });
      process.send({ event: "SCAN_MAIN_LOGS", payload: { mainLogs } });
    },
    log(msg) {
      // default log at level info
      this.__internal__("info", msg);
    },
    debug(msg) {
      this.__internal__("debug", msg);
    },
    info(msg) {
      this.__internal__("info", msg);
    },
    error(msg) {
      this.__internal__("error", msg);
    },
    warn(msg) {
      this.__internal__("warn", msg);
    },
  },
  result: {
    add(rjcode, result, count) {
      results.push({
        rjcode,
        result,
        count,
      });
      process.send({
        event: "SCAN_RESULTS",
        payload: { results },
      });
    },
  },
  task: {
    // 添加作品专门的log记录
    add(taskId) {
      // taskId == rjcode, e.g. "443322" or "01134321"
      // console.log("[TASK] Add", taskId);
      console.assert(typeof taskId === "string" && (taskId.length === 6 || taskId.length === 8));
      tasks.push({
        rjcode: taskId,
        result: null,
        logs: [],
      });
    },

    // 移除作品的专属log，如果该作品的对应任务失败，则发送相应的失败消息
    remove(taskId, result) {
      // console.log("[task] Remove", taskId);
      const index = tasks.findIndex((task) => task.rjcode === taskId);
      if (index == -1) {
        // 当前任务并没有被添加，则跳过remove操作
        return;
      }

      const removedTask = tasks[index];
      removedTask.result = result;
      tasks.splice(index, 1);
      process.send({ event: "SCAN_TASKS", payload: { tasks } });

      if (removedTask.result === "failed") {
        failedTasks.push(removedTask);
        process.send({ event: "SCAN_FAILED_TASKS", payload: { failedTasks } });
      }
    },
    __internal_task__(taskId, level, msg) {
      console.assert(typeof taskId === "string" && (taskId.length === 6 || taskId.length === 8));
      console[level](`-> [RJ${taskId}]`, msg);

      const task = tasks.find((task) => task.rjcode === taskId);
      if (task) {
        task.logs.push({ level, message: msg });
        process.send({ event: "SCAN_TASKS", payload: { tasks } });
      }
    },
    log(taskId, msg) {
      // default log at level info
      this.__internal_task__(taskId, "info", msg);
    },
    debug(taskId, msg) {
      this.__internal_task__(taskId, "debug", msg);
    },
    info(taskId, msg) {
      this.__internal_task__(taskId, "info", msg);
    },
    error(taskId, msg) {
      this.__internal_task__(taskId, "error", msg);
    },
    warn(taskId, msg) {
      this.__internal_task__(taskId, "warn", msg);
    },
  },
};

process.on("message", (m) => {
  if (m.emit === "SCAN_INIT_STATE") {
    process.send({
      event: "SCAN_INIT_STATE",
      payload: {
        tasks,
        failedTasks,
        mainLogs,
        results,
      },
    });
  } else if (m.exit) {
    logger.main.error("  ! 终止扫描过程.");
    process.exit(1);
  }
});

/**
 * 通过数组 arr 中每个对象的 id 属性来对数组去重
 * @param {Array} arr
 */
function uniqueArr(arr) {
  const unique = [];
  const duplicate = {};

  for (let i = 0; i < arr.length; i++) {
    for (let j = i + 1; j < arr.length; j++) {
      if (arr[i].id === arr[j].id) {
        duplicate[arr[i].id] = duplicate[arr[i].id] || [];
        duplicate[arr[i].id].push(arr[i]);
        ++i;
      }
    }
    unique.push(arr[i]);
  }

  return {
    unique, // 去重后的数组
    duplicate, // 对象，键为id，值为多余的重复项数组
  };
}

async function scrapeWorkMetadata(id, language) {
  const rjcode = id;
  return scrapeWorkMetadataFromDLsite(id, language)
    .then((metadata) => {
      return metadata;
    })
    .catch((err) => {
      logger.task.warn(rjcode, `DLSite获取元数据失败: ${err.message}`);
      return scrapeWorkMetadataFromAsmrOne(id, language)
        .then((metadata) => {
          return metadata;
        })
        .catch((err) => {
          logger.task.warn(rjcocde, `asmr-one获取元数据失败: ${err.message}`);
          throw err;
        });
    });
}

/**
 * 从 DLsite 抓取该音声的元数据，并保存到数据库，
 * 返回一个 Promise 对象，处理结果: 'added' or 'failed'
 * @param {object} folder
 * @param {string} tagLanguage 标签语言，'ja-jp', 'zh-tw' or 'zh-cn'，默认'zh-cn'
 */
async function getMetadata(folder, tagLanguage) {
  const rjcode = folder.id;

  // 先从DLSite抓取元数据，若失败则从asmr-one抓取元数据
  return scrapeWorkMetadata(folder.id, tagLanguage)
    .then((metadata) => {
      logger.task.info(rjcode, "元数据抓取成功，准备获取作品播放时长...");
      return getWorkDuration(folder.id, folder.absolutePath)
        .then((duration) => {
          logger.task.info(rjcode, "作品播放时长获取成功，准备添加到数据库...");

          metadata.rootFolderName = folder.rootFolderName;
          metadata.dir = folder.relativePath;
          metadata.addTime = folder.addTime;
          metadata.duration = duration;

          return db
            .insertWorkMetadata(metadata)
            .then(() => {
              logger.task.info(rjcode, "元数据成功添加到数据库.");
              return "added";
            })
            .catch((err) => {
              logger.task.warn(rjcode, `元数据添加失败: ${err.message}`);
              return "failed";
            });
        })
        .catch((err) => {
          logger.task.warn(`作品播放时长获取失败: ${err.message}`);
          return "failed";
        });
    })
    .catch((err) => {
      logger.task.warn(rjcode, `元数据抓取失败: ${err.message}`);
      return "failed";
    });
}

/**
 * 从 DLsite 下载封面图片，并保存到 Images 文件夹，
 * 返回一个 Promise 对象，处理结果: 'added' or 'failed'
 * @param {number} id work id
 * @param {Array} types img types: ['main', 'sam', 'sam@2x', 'sam@3x', '240x240', '360x360']
 */
const getCoverImage = (id, types) => {
  const rjcode = id;
  const id2 = id % 1000 === 0 ? id : parseInt(id / 1000) * 1000 + 1000;
  let rjcode2 = String(id2);
  if (id2 >= 1000000) {
    rjcode2 = `0${id2}`.slice(-8);
  }
  const promises = [];
  types.forEach((type) => {
    let url = `https://img.dlsite.jp/modpub/images2/work/doujin/RJ${rjcode2}/RJ${rjcode}_img_${type}.jpg`;
    if (type === "240x240" || type === "360x360") {
      url = `https://img.dlsite.jp/resize/images2/work/doujin/RJ${rjcode2}/RJ${rjcode}_img_main_${type}.jpg`;
    }
    promises.push(
      axios
        .retryGet(url, { responseType: "stream", retry: {} })
        .then((imageRes) => {
          return saveCoverImageToDisk(imageRes.data, rjcode, type).then(() => {
            logger.task.info(rjcode, `封面 RJ${rjcode}_img_${type}.jpg 下载成功.`);
            return "added";
          });
        })
        .catch((err) => {
          logger.task.info(rjcode, `在下载封面 RJ${rjcode}_img_${type}.jpg 过程中出错: ${err.message}`);
          return "failed";
        })
    );
  });

  logger.task.info(rjcode, `从 DLsite 下载封面...`);

  return Promise.all(promises).then((results) => {
    results.forEach((result) => {
      if (result === "failed") {
        return "failed";
      }
    });

    return "added";
  });
};

/**
 * 获取音声元数据，获取音声封面图片，
 * 返回一个 Promise 对象，处理结果: 'added', 'skipped' or 'failed'
 * @param {string} folder 音声文件夹对象 { relativePath: '相对路径', rootFolderName: '根文件夹别名', id: '音声ID' }
 */
async function processFolder(folder) {
  return db
    .knex("t_work")
    .select("id")
    .where("id", "=", folder.id)
    .count()
    .first()
    .then((res) => {
      const rjcode = folder.id;
      const coverTypes = ["main", "sam", "240x240"];
      const count = res["count(*)"];
      if (count) {
        // 查询数据库，检查是否已经写入该音声的元数据
        // 已经成功写入元数据
        // 检查音声封面图片是否缺失
        const lostCoverTypes = [];
        coverTypes.forEach((type) => {
          const coverPath = path.join(config.coverFolderDir, `RJ${rjcode}_img_${type}.jpg`);
          if (!fs.existsSync(coverPath)) {
            lostCoverTypes.push(type);
          }
        });

        if (lostCoverTypes.length) {
          logger.task.add(rjcode);
          logger.task.info(rjcode, "封面图片缺失，重新下载封面图片...");

          return getCoverImage(folder.id, lostCoverTypes);
        } else {
          return "skipped";
        }
      } else {
        logger.task.add(rjcode);
        logger.task.info(rjcode, `发现新文件夹: "${folder.absolutePath}"`);

        return getMetadata(folder, config.tagLanguage) // 获取元数据
          .then((result) => {
            if (result === "failed") {
              // 如果获取元数据失败，跳过封面图片下载
              return "failed";
            } else {
              // 下载封面图片
              return getCoverImage(folder.id, coverTypes);
            }
          });
      }
    });
}

const MAX = config.maxParallelism; // 并发请求上限
const limitP = new LimitPromise(MAX); // 核心控制器
/**
 * 限制 processFolder 并发数量，
 * 使用控制器包装 processFolder 方法，实际上是将请求函数递交给控制器处理
 */
async function processFolderLimited(folder) {
  return await limitP.call(processFolder, folder);
}

/**
 * 清理本地不再存在的音声: 将其元数据从数据库中移除，并删除其封面图片
 */
async function performCleanup() {
  const trxProvider = db.knex.transactionProvider();
  const trx = await trxProvider();
  const works = await trx("t_work").select("id", "root_folder", "dir");

  await Promise.all(
    works.map(async (work) => {
      const rootFolder = config.rootFolders.find((rootFolder) => rootFolder.name === work.root_folder);
      if (rootFolder && fs.existsSync(path.join(rootFolder.path, work.dir))) {
        // 仍然存在，不需要清理
        return;
      }

      await db.removeWork(work.id, trxProvider);
      const rjcode = work.id;
      try {
        await deleteCoverImageFromDisk(rjcode);
      } catch (err) {
        if (err && err.code !== "ENOENT") {
          logger.main.error(`  ! [RJ${rjcode}] 在删除封面过程中出错: ${err.messsage}`);
        }
      }
    })
  );
  trx.commit();
}

// 尝试创建数据库
async function tryCreateDatabase() {
  try {
    await createSchema();
  } catch (err) {
    logger.main.error(`  ! 在构建数据库结构过程中出错: ${err.message}`);
    console.error(err.stack);
    process.exit(1);
  }
}

// 尝试创建管理员账号，如果已存在则忽略
// 如果发生其他异常则直接杀死本进程
async function tryCreateAdminUser() {
  try {
    // 创建内置的管理员账号
    await db.createUser({
      name: "admin",
      password: md5("admin"),
      group: "administrator",
    });
  } catch (err) {
    if (err.message.indexOf("已存在") === -1) {
      logger.main.error(`  ! 在创建 admin 账号时出错: ${err.message}`);
      process.exit(1);
    }
  }
}

// 修复以往的数据库问题，老逻辑了，不太清楚具体修复的问题是什么，先放在这里
// 成功返回true，失败返回false
async function fixVADatabase() {
  // Fix hash collision bug in t_va
  // Scan to repopulate the Voice Actor data for those problematic works
  // かの仔 and こっこ
  let success = true;
  if (updateLock.isLockFilePresent && updateLock.lockFileConfig.fixVA) {
    logger.main.log(" -> 开始进行声优元数据修复，需要联网");
    try {
      const updateResult = await fixVoiceActorBug();
      counts.updated += updateResult;
      updateLock.removeLockFile();
      logger.main.log(" -> 完成元数据修复");
    } catch (err) {
      logger.main.error(" ->", err.toString());
      success = false;
    }
  }
  return success;
}

// 尝试清理不存在的数据，该阶段可能会根据用户配置跳过
// 如果清理过程中发生一场则杀死该进程
async function tryCleanupStage() {
  if (config.skipCleanup) {
    logger.main.info(" -> 跳过清理“不存在的音声数据”");
  } else {
    try {
      logger.main.info(" -> 清理本地不再存在的音声的数据与封面图片...");
      await performCleanup();
      logger.main.info(" -> 清理完成. 现在开始扫描...");
    } catch (err) {
      logger.main.error(`  ! 在执行清理过程中出错: ${err.message}`);
      process.exit(1);
    }
  }
}

// 尝试扫描所有媒体库的文件夹
// 返回扫描得到的work的文件夹
async function tryScanRootFolders() {
  let folderList = [];
  try {
    for (const rootFolder of config.rootFolders) {
      for await (const folder of getFolderList(rootFolder, "", 0, logger.main)) {
        folderList.push(folder);
      }
    }
    logger.main.info(` -> 共找到 ${folderList.length} 个音声文件夹.`);
  } catch (err) {
    logger.main.error(`  ! 在扫描根文件夹的过程中出错: ${err.message}`);
    process.exit(1);
  }
  return folderList;
}

// 并行处理这些文件夹
// 返回总的处理结果，表明处理的数量
// {
//   added: 0, // 添加的文件夹数量
//   failed: 0, // 失败
//   skipped: 0, // 跳过
//   updated: 0, // 更新
// };
async function tryProcessFolderListParallel(folderList) {
  const counts = {
    added: 0,
    failed: 0,
    skipped: 0,
    updated: 0,
  };

  try {
    // 去重，避免在之后的并行处理文件夹过程中，出现对数据库同时写入同一条记录的错误
    const { uniqueList: uniqueFolderList, duplicateSet } = uniqueArr(folderList);
    const duplicateNum = folderList.length - uniqueFolderList.length;

    if (duplicateNum) {
      logger.main.info(` -> 发现 ${duplicateNum} 个重复的音声文件夹.`);

      for (const key in duplicateSet) {
        // duplicateSet中并不包含存在于uniqueFolderList中的文件夹，
        // 将unique和duplicate重复的选项添加回duplicateSet，方便用户观察那些文件夹是重复的
        const addedFolder = uniqueFolderList.find((folder) => folder.id === parseInt(key));
        duplicateSet[key].push(addedFolder); // 最后一项为是被添加到数据库中的音声文件夹，将其一同展示给用户

        const rjcode = key; // zero-pad to 6 or 8 digits

        logger.main.info(` -> [RJ${rjcode}] 存在多个文件夹:`);

        // 打印音声文件夹的绝对路径
        duplicateSet[key].forEach((folder) => {
          const rootFolder = config.rootFolders.find((rootFolder) => rootFolder.name === folder.rootFolderName);
          const absolutePath = path.join(rootFolder.path, folder.relativePath);
          logger.main.info(` --> ${absolutePath}`);
        });
      }
    }

    counts.skipped += duplicateNum;

    await Promise.all(
      uniqueFolderList.map(async (folder) => {
        const result = await processFolderLimited(folder);
        counts[result] += 1;

        const rjcode = folder.id; // zero-pad to 6 digits\
        switch (result) {
          case "added":
            logger.task.info(rjcode, `添加成功! Added: ${counts.added}`);
            break;
          case "failed":
            logger.task.error(rjcode, `添加失败! Failed: ${counts.failed}`);
            break;
          default:
            break;
        }
        logger.task.remove(rjcode, result);
        if (result !== "skipped") logger.result.add(rjcode, result, counts[result]);
      })
    );
  } catch (err) {
    logger.main.error(`  ! 在并行处理音声文件夹过程中出错: ${err.message}`);
    console.error(err.stack);
    process.exit(1);
  }

  return counts;
}

/**
 * 执行扫描
 * createCoverFolder => createSchema => cleanup => getAllFolderList => processAllFolder
 */
async function performScan() {
  if (!fs.existsSync(config.coverFolderDir)) {
    try {
      fs.mkdirSync(config.coverFolderDir, { recursive: true });
    } catch (err) {
      logger.main.error(`  ! 在创建存放音声封面图片的文件夹时出错: ${err.message}`);
      process.exit(1);
    }
  }

  await tryCreateDatabase();
  await tryCreateAdminUser();

  const fixVADatabaseSuccess = await fixVADatabase();
  await tryCleanupStage();

  const folderList = await tryScanRootFolders();
  const folderResult = await tryProcessFolderListParallel(folderList);

  const message = folderResult.updated
    ? `扫描完成: 更新 ${folderResult.updated} 个，新增 ${folderResult.added} 个，跳过 ${folderResult.skipped} 个，失败 ${folderResult.failed} 个.`
    : `扫描完成: 新增 ${folderResult.added} 个，跳过 ${folderResult.skipped} 个，失败 ${folderResult.failed} 个.`;
  logger.finish(message);

  db.knex.destroy();
  if (!fixVADatabaseSuccess) {
    process.exit(1);
  }
  process.exit(0);
}

/**
 * 更新音声的动态元数据
 * @param {number} id work id
 * @param {options = {}} options includeVA, includeTags
 */
async function updateMetadata(id, options = {}) {
  let scrapeProcessor = () => scrapeDynamicWorkMetadataFromDLsite(id);
  if (options.includeVA || options.includeTags || options.includeNSFW || options.refreshAll) {
    // static + dynamic
    scrapeProcessor = () => scrapeWorkMetadata(id, config.tagLanguage);
  }

  const rjcode = id;
  logger.task.add(rjcode); // logger.task.add only accepts a string

  try {
    const metadata = await scrapeProcessor(); // 抓取该音声的元数据
    // 将抓取到的元数据插入到数据库
    logger.task.log(rjcode, `元数据抓取成功，准备更新元数据...`);
    metadata.id = id;

    await db.updateWorkMetadata(metadata, options);
    logger.task.log(rjcode, `元数据更新成功`);
    return "updated";
  } catch (err) {
    logger.task.error(rjcode, `在抓取元数据过程中出错: ${err}`);
    console.error(err.stack);
    return "failed";
  }
}

const updateMetadataLimited = (id, options = null) => limitP.call(updateMetadata, id, options);
const updateVoiceActorLimited = (id) => limitP.call(updateMetadata, id, { includeVA: true });

// eslint-disable-next-line no-unused-vars
async function performUpdate(options = null) {
  const baseQuery = db.knex("t_work").select("id");
  const processor = (id) => updateMetadataLimited(id, options);

  const counts = await refreshWorks(baseQuery, "id", processor);

  const message = `扫描完成: 更新 ${counts.updated} 个，失败 ${counts.failed} 个.`;
  logger.finish(message);
  db.knex.destroy();
  if (counts.failed) process.exit(1);
}

async function fixVoiceActorBug() {
  const baseQuery = db.knex("r_va_work").select("va_id", "work_id");
  const filter = (query) => query.where("va_id", nameToUUID("かの仔")).orWhere("va_id", nameToUUID("こっこ"));
  const processor = (id) => updateVoiceActorLimited(id);
  return await refreshWorks(filter(baseQuery), "work_id", processor);
}

async function refreshWorks(query, idColumnName, processor) {
  return query.then(async (works) => {
    logger.main.info(`共 ${works.length} 个音声. 开始刷新`);

    const counts = {
      updated: 0,
      failed: 0,
    };

    await Promise.all(
      works.map(async (work) => {
        const workid = work[idColumnName];
        const rjcode = workid;

        const result = (await processor(workid)) === "failed" ? "failed" : "updated";

        counts[result]++;
        logger.task.remove(rjcode, result);
        logger.result.add(rjcode, result, counts[result]);
      })
    );

    logger.main.log(`完成元数据更新 ${counts.updated} 个，失败 ${counts.failed} 个.`);
    return counts;
    s;
  });
}

module.exports = { performScan, performUpdate };
