require('dotenv').config();

const axios = require('axios');
const cheerio = require('cheerio');
const mailgun = require('mailgun-js')({
  apiKey  : process.env.MAILGUN_KEY,
  domain  : process.env.MAILGUN_DOMAIN
});

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
  return axios.get(process.env.URL, {
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

        let name = $(tds[0]).find('a.body').text().trim();
        name = getNameFromPossiblyMalformedString(name);

        if (!name) return;

        const number = $(tds[1]).text().trim();

        const dbPartner = partners.find({name: name});
        const partner = dbPartner.value();
        if (partner !== undefined) {
          // check if number changed
          if (number !== partner.number) {
            // update it if so
            changed.push(`${name}: ${number}`);
            dbPartner.assign({number: number}).write();
          }

          // partner is current
          dbPartner.assign({current: true}).write();
        } else {
          if (!!number) {
            joined.push(`${name}: ${number}`);
          } else {
            joined.push(name);
          }

          partners.push({name: name, number: number, current: true}).write();
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
    if (!!partner.number) {
      left.push(`${partner.name}: ${partner.number}`);
    } else {
      left.push(partner.name);
    }

    dbPartners.remove({name: partner.name}).write();
  });

  return left;
}

function buildEmailTextFromChangedPartners(changedPartnersObj) {
  let emailText = '';
  if (!changedPartnersObj) return emailText;

  const joined = changedPartnersObj.joined;
  const left = changedPartnersObj.left;
  const changed = changedPartnersObj.changed;

  if (joined.length > 0) {
    emailText += '<p><strong>Joined</strong></p>';
    emailText += '<ul>';
    joined.forEach(function(partnerInfo) {
      emailText += `<li>${partnerInfo}</li>`;
    });
    emailText += '</ul><br>';
  }

  if (left.length > 0) {
    emailText += '<p><strong>Left</strong></p>';
    emailText += '<ul>';
    left.forEach(function(partnerInfo) {
      emailText += `<li>${partnerInfo}</li>`;
    });
    emailText += '</ul><br>';
  }

  if (changed.length > 0) {
    emailText += '<p><strong>Changed</strong></p>';
    emailText += '<ul>';
    changed.forEach(function(partnerInfo) {
      emailText += `<li>${partnerInfo}</li>`;
    });
    emailText += '</ul><br>';
  }

  return emailText;
}

function asyncSendEmail(emailAddress, text) {
  return new Promise(function(resolve, reject) {
    try {
      if (!emailAddress) reject('emailAddress must be non-null');

      if (!text) {
        text = 'No changes this week!';
      }

      const today = new Date();
      const date = `${today.getMonth() + 1}/${today.getDate()}`;
      const email = {
        from: `Who's New? <${process.env.MAILGUN_SENDER}>`,
        to: emailAddress,
        subject: `Who's New? Weekly Update ${date}`,
        html: text
      };

      mailgun.messages().send(email, function(err, body){
        if(err) {
          reject(err);
        } else {
          resolve('sent an email to ' + email);
        }
      });
    } catch(e) {
      reject(e);
    }
  })
};

function asyncSendEmailToGroup(text) {
  return new Promise(function(resolve, reject) {
    try {
      const recipients = process.env.EMAIL_RECIPIENTS.split(',');

      Promise
        .map(recipients, function(recipient) {
          return asyncSendEmail(recipient, text);
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

      console.log('changes', changedPartners);

      const emailText = buildEmailTextFromChangedPartners(changedPartners);
      return asyncSendEmailToGroup(emailText);
    })
    .catch(function(err) {
      console.error('Error:', err);
    })
}

run();
