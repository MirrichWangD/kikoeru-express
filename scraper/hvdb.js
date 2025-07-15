const htmlparser = require('htmlparser2'); // 解析器

const axios = require('./axios'); // 数据请求
const { nameToUUID } = require('./utils');

/**
 * Scrapes work metadata from public HVDB page HTML.
 * @param {number} id Work id.
 */
const scrapeWorkMetadataFromHVDB = id =>
  new Promise((resolve, reject) => {
    const rjcode = id;
    const url = `https://hvdb.me/Dashboard/WorkDetails/${id}`;

    console.log(`[RJ${rjcode}] 从 HVDB 抓取元数据...`);
    axios
      .retryGet(url, { retry: {} })
      .then(response => {
        return response.data;
      })
      .then(data => {
        //解析
        const work = { id, tags: [], vas: [] };
        let textBuffer = '';
        let writeTo;

        const parser = new htmlparser.Parser(
          {
            onopentag: (name, attrs) => {
              // 标签名 属性
              if (name === 'input') {
                if (attrs.id === 'Name') {
                  work.title = attrs.value;
                } else if (attrs.name === 'SFW') {
                  work.nsfw = attrs.value === 'false';
                }
              }

              if (name === 'a') {
                if (attrs.href.includes('CircleWorks')) {
                  work.circle = {
                    id: attrs.href.substring(attrs.href.lastIndexOf('/') + 1)
                  };
                  writeTo = 'circle.name';
                  textBuffer = '';
                } else if (attrs.href.includes('TagWorks')) {
                  work.tags.push({
                    id: attrs.href.substring(attrs.href.lastIndexOf('/') + 1)
                  });
                  writeTo = 'tag.name';
                  textBuffer = '';
                } else if (attrs.href.includes('CVWorks')) {
                  work.vas.push({}); // 占位
                  writeTo = 'va.name';
                  textBuffer = '';
                }
              }
            },
            onclosetag: () => {
              switch (writeTo) {
                case 'circle.name':
                  work.circle.name = textBuffer.trim();
                  break
                case 'tag.name':
                  work.tags[work.tags.length - 1].name = textBuffer.trim();
                  break
                case 'va.name':
                  work.vas[work.vas.length - 1].name = textBuffer.trim();
                  work.vas[work.vas.length - 1].id = nameToUUID(textBuffer.trim());
                  break
              }
              textBuffer = '';
              writeTo = null;
            },
            ontext: text => {
              textBuffer += text;
            }
          },
          { decodeEntities: true }
        );
        parser.write(data);
        parser.end();

        if (work.tags.length === 0 && work.vas.length === 0) {
          reject(new Error("Couldn't parse data from HVDB work page."));
        } else {
          console.log(`[RJ${rjcode}] 成功从 HVDB 抓取元数据...`);
          resolve(work);
        }
      })
      .catch(error => {
        if (error.response) {
          // 请求已发出，但服务器响应的状态码不在 2xx 范围内
          reject(new Error(`Couldn't request work page HTML (${url}), received: ${error.response.status}.`));
        } else if (error.request) {
          reject(error);
          console.log(error.request);
        } else {
          console.log('Error', error.message);
          reject(error);
        }
      });
  });

module.exports = scrapeWorkMetadataFromHVDB;
