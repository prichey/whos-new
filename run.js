require('dotenv').config();

const fs = require('fs');
const axios = require('axios');
const cheerio = require('cheerio');
const urlencode = require('urlencode');
const mailgun = require('mailgun-js')({
  apiKey  : process.env.MAILGUN_KEY,
  domain  : process.env.MAILGUN_DOMAIN
});
const MailComposer = require('nodemailer/lib/mail-composer');

const Promise = require('bluebird');
const low = require('lowdb');
const db = low('db.json');

function setDbDefaults() {
  // make sure
  db.defaults({ partners: [] }).write();
}

function markAllNotCurrent() {
  // mark everyone in the db as not current to know who has left

  const dbPartners = db.get('partners');
  const partners = dbPartners.value();

  partners.forEach(function(partner, index) {
    dbPartners
      .find({name: partner.name})
      .assign({current: false})
      .write();
  });
}

function asyncGetCurrentPartnerListHtml() {
  return axios.get(`${process.env.URL_BASE}/partnerinfo.asp`, {
      auth: {
        username: process.env.AUTH_USER,
        password: process.env.AUTH_PASS
      }
    });
}

function getNameFromPossiblyMalformedString(name) {
  if (!!name && name.indexOf(', ')) {
    const nameParts = name.split(', ');

    if (nameParts.length === 2) {
      name = `${nameParts[1]} ${nameParts[0]}`;
    } else if (nameParts.length > 2) {
      name = '';
    }
  }

  return name;
}

function asyncParseCurrentPartnerList(resp) {
  return new Promise(function(resolve, reject) {
    try {
      const $ = cheerio.load(resp.data);
      const partners = db.get('partners');

      let joined = [];
      let changed = [];

      $('table.body').find('tr').each(function(i, el) {
        const tds = $(el).find('td');

        const rawName = $(tds[0]).find('a.body').text().trim();
        const name = getNameFromPossiblyMalformedString(rawName);

        if (!name) return;

        const partnerUrl = $(tds[0]).find('a.body').attr('href');
        const imgUrl = `${process.env.URL_BASE}/emppics/${urlencode(rawName)}.jpg`;
        const number = $(tds[1]).text().trim();

        const dbPartner = partners.find({name: name});
        const partner = dbPartner.value();
        const partnerObj = {
          name: name,
          rawName: rawName,
          nameWithoutSpaces: name.replace(/\s/g, ''),
          number: number,
          current: true,
          url: `${process.env.URL_BASE}/${partnerUrl}`,
          imgUrl: imgUrl
        };

        if (partner !== undefined) {
          // check if number changed
          if (number !== partner.number) {
            // update it if so
            changed.push(partnerObj);
            dbPartner.assign({number: number}).write();
          }

          // partner is current
          dbPartner.assign({current: true}).write();
        } else {
          joined.push(partnerObj);
          partners.push(partnerObj).write();
        }
      });

      resolve({
        joined: joined,
        changed: changed
      });
    } catch(e) {
      reject(e);
    }
  })
}

function getLeftPartnersFromDb() {
  const dbPartners = db.get('partners');
  const notCurrentPartners = dbPartners.filter({current: false}).value();
  let left = [];

  notCurrentPartners.forEach(function(partner) {
    left.push(partner);
    dbPartner.assign({current: false}).write();
  });

  return left;
}

function getEmailTextFromPartnerInfo(partnerInfo) {
  if (!!partnerInfo && !!partnerInfo.name) {
    if (!!partnerInfo.number) {
      return `${partnerInfo.name}: ${partnerInfo.number}`;
    } else {
      return partnerInfo.name;
    }
  } else {
    return '';
  }
}

function asyncBuildEmailFromChangedPartners(changedPartnersObj) {
  return new Promise(function(resolve, reject) {
    if (!changedPartnersObj) resolve({
      text: 'No changed partners this week!',
      attachments: []
    });

    const today = new Date();
    const date = `${today.getMonth() + 1}/${today.getDate()}`;

    let emailConfig = {
      attachments: [],
      html: '',
      from: `Who's New? <${process.env.MAILGUN_SENDER}>`,
      subject: `Who's New? Weekly Update ${date}`,
    };

    const partnerGroups = [
      {
        name: "Joined",
        constituents: changedPartnersObj.joined
      },
      {
        name: "Left",
        constituents: changedPartnersObj.left
      },
      {
        name: "Changed",
        constituents: changedPartnersObj.changed
      },
    ];

    partnerGroups.forEach(function(partnerGroup) {
      if (partnerGroup.constituents.length > 0) {
        emailConfig.html += `<p><strong>${partnerGroup.name}</strong></p>`;
        emailConfig.html += '<ul>';

        partnerGroup.constituents.forEach(function(partnerInfo) {
          let partnerEmailText = getEmailTextFromPartnerInfo(partnerInfo);

          if (partnerEmailText !== '') {
            emailConfig.html += '<li>';
            emailConfig.html += partnerEmailText;

            const fileName = `${partnerInfo.nameWithoutSpaces}.jpg`;
            const filePath = `./img/${fileName}`;

            if (fs.existsSync(filePath) === true) {
              emailConfig.attachments.push({
                filename: fileName,
                path: `./img/${fileName}`,
                cid: partnerInfo.nameWithoutSpaces
              });

              emailConfig.html += `<img style="display: block;" src="cid:${fileName}" />`;
            }
            emailConfig.html += '</li>';
          }
        });

        emailConfig.html += '</ul><br>';
      }
    })

    if (emailConfig.html === '') {
      emailConfig.html = 'No changes this week!';
    }

    console.log('Email config:', emailConfig);

    resolve(emailConfig);
  })
}

function asyncSendEmail(emailAddress, emailConfig) {
  return new Promise(function(resolve, reject) {
    try {
      if (!emailAddress) reject(new Error('emailAddress must be non-null'));

      emailConfig.to = emailAddress;

      const email = new MailComposer(emailConfig);

      email.compile().build(function(mailBuildError, message) {
        const mimeData = {
          to: emailAddress,
          message: message.toString('ascii')
        };

        mailgun.messages().sendMime(mimeData, function(err, body) {
          if (err) {
            reject(err);
          } else {
            resolve('sent an email to ' + emailAddress);
          }
        })
      })
    } catch(e) {
      reject(e);
    }
  });
};

function asyncSendEmailToGroup(emailConfig) {
  return new Promise(function(resolve, reject) {
    try {
      const recipients = process.env.EMAIL_RECIPIENTS.split(',');

      Promise
        .map(recipients, function(recipient) {
          return asyncSendEmail(recipient, emailConfig);
        })
        .then(function() {
          resolve('emails successfully sent to group');
        })
        .catch(function(e) {
          reject(e);
        })
    } catch(e) {
      reject(e);
    }
  })
}

function getConcattedAllPartnersListFromChangedPartnersObj(changedPartners) {
  let allPartners = [];
  if (!!changedPartners.joined && changedPartners.joined.length > 0) {
    allPartners = allPartners.concat(changedPartners.joined);
  }
  if (!!changedPartners.changed && changedPartners.changed.length > 0) {
    allPartners = allPartners.concat(changedPartners.changed);
  }
  if (!!changedPartners.left && changedPartners.left.length > 0) {
    allPartners = allPartners.concat(changedPartners.left);
  }
  return allPartners;
}

function asyncDownloadPartnerPhotoIfNecessary(partner) {
  return new Promise(function(resolve, reject) {
    if (!!partner && !!partner.nameWithoutSpaces && !!partner.imgUrl) {
      const imagePath = `./img/${partner.nameWithoutSpaces}.jpg`;
      if (fs.existsSync(imagePath) !== true) {
        // file does not exist, attempt to download
        console.log('attempting to download to ', imagePath)
        asyncDownloadFile(partner.imgUrl, imagePath)
          .then(function(res) {
            resolve(res)
          })
          .catch(function(e) {
            reject(e);
          })
      } else {
        conosle.log('photo already downloaded');
        resolve('file already downloaded');
      }
    } else {
      reject(new Error('malformed partner'));
    }
  });
}

function asyncDownloadPhotosOfPartnersIfNecessary(changedPartners) {
  return new Promise(function(resolve, reject) {
    const allPartners = getConcattedAllPartnersListFromChangedPartnersObj(changedPartners);
    Promise
      .map(allPartners, function(partner) {
        return asyncDownloadPartnerPhotoIfNecessary(partner);
      })
      .then(function(res) {
        resolve(changedPartners)
      })
      .catch(function(e) {
        reject(e);
      });
  });
}

function asyncDownloadFile(url, filename) {
  return new Promise(function(resolve, reject) {
    axios({
      method: 'get',
      url: url,
      responseType: 'stream',
      auth: {
        username: process.env.AUTH_USER,
        password: process.env.AUTH_PASS
      }
    })
    .then(function(resp) {
      resp.data.pipe(fs.createWriteStream(filename))
    })
    .then(function() {
      console.log(`${filename} downloaded`);
      resolve();
    });
  })
}

function run() {
  setDbDefaults();
  markAllNotCurrent();
  asyncGetCurrentPartnerListHtml()
    .then(function(resp) {
      return asyncParseCurrentPartnerList(resp)
    })
    .then(function(changedPartners) {
      const leftPartners = getLeftPartnersFromDb();
      changedPartners.left = leftPartners;

      console.log('Changes:', changedPartners);
      return changedPartners;
    })
    .then(function(changedPartners) {
      return asyncDownloadPhotosOfPartnersIfNecessary(changedPartners)
    })
    .then(function(changedPartners) {
      return asyncBuildEmailFromChangedPartners(changedPartners);
    })
    .then(function(emailConfig) {
      return asyncSendEmailToGroup(emailConfig);
    })
    .then(function() {
      console.log('Success!');
    })
    .catch(function(err) {
      console.error('Error:', err);
    })
}

run();
