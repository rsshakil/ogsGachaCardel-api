/**
 * @type {import('@types/aws-lambda').APIGatewayProxyHandler}
 */
const AWS = require('aws-sdk')
const mysql = require("mysql2/promise");
const ssm = new AWS.SSM();
const lambda = new AWS.Lambda();
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const redis = require('ioredis');

const PAGES_VISITED = 0;
const ITEMS_PER_PAGE = 500;
/**
 * ManagerAppRead.
 * 
 * @param {*} event 
 * @returns {json} response
 */
exports.handler = async (event) => {
    console.log("Event data:", event);
    // Reading encrypted environment variables --- required
    if (process.env.DBINFO == null) {
        const ssmreq = {
            Name: 'PS_' + process.env.ENV,
            WithDecryption: true
        };
        const ssmparam = await ssm.getParameter(ssmreq).promise();
        const dbinfo = JSON.parse(ssmparam.Parameter.Value);
        process.env.DBWRITEENDPOINT = dbinfo.DBWRITEENDPOINT;
        process.env.DBREADENDPOINT = dbinfo.DBREADENDPOINT;
        process.env.DBUSER = dbinfo.DBUSER;
        process.env.DBPASSWORD = dbinfo.DBPASSWORD;
        process.env.DBDATABSE = dbinfo.DBDATABSE;
        process.env.DBPORT = dbinfo.DBPORT;
        process.env.DBCHARSET = dbinfo.DBCHARSET;
        process.env.DBINFO = true;
        process.env.REDISPOINT1 = dbinfo.REDISPOINT1;
        process.env.REDISPOINT2 = dbinfo.REDISPOINT2;
        process.env.ENVID = dbinfo.ENVID;
        process.env.REGISTURL = dbinfo.REGISTURL
        process.env.MAILFROM = dbinfo.MAILFROM
        process.env.DIRECTION = dbinfo.DIRECTION;
        process.env.DEFAULTCOUNTRYID = dbinfo.DEFAULTCOUNTRYID;
        process.env.DEFAULTLANGUAGEID = dbinfo.DEFAULTLANGUAGEID;
    }

    // Database info
    const writeDbConfig = {
        host: process.env.DBWRITEENDPOINT,
        user: process.env.DBUSER,
        password: process.env.DBPASSWORD,
        database: process.env.DBDATABSE,
        charset: process.env.DBCHARSET
    };
    const ENVID = process.env.ENVID;
    const DEFAULTCOUNTRYID = process.env.DEFAULTCOUNTRYID;
    const DEFAULTLANGUAGEID = process.env.DEFAULTLANGUAGEID;
    const redisConfig = [
        { host: process.env.REDISPOINT1, port: 6379 },
        { host: process.env.REDISPOINT2, port: 6379 }
    ];
    const cluster = new redis.Cluster(
        redisConfig,
        {
            dnsLookup: (address, callback) => callback(null, address),
            redisOptions: { tls: true }
        }
    );

    const DIRECTION = (process.env.DIRECTION)?process.env.DIRECTION:1;
    const registURL = process.env.REGISTURL;
    let mysql_con;
    let response;

    // ユーザーの登録処理
    // 1. データベースに登録（仮登録状態）
    // 2. メールアドレスに本登録メールを発行（送信）

    try {
        const {
            emailAddress,
            password,
            confirmedPassword,
            invitationCode
        } = JSON.parse(event.body);
        // mysql connect
        mysql_con = await mysql.createConnection(writeDbConfig);

        // return error
        if (emailAddress != null && password != null && confirmedPassword != null && (password == confirmedPassword)) {
            // そのメールを利用したデータが存在するかチェック
            const checkSql = `SELECT COUNT(userId) AS cnt, userRegistFlag, userRegistExpiredAt FROM User WHERE userEmail = ? GROUP BY userRegistFlag, userRegistExpiredAt`;
            const [query_result_count] = await mysql_con.execute(checkSql, [emailAddress]);
            // データが存在する
            if (query_result_count && query_result_count[0] && query_result_count[0].cnt > 0) {
                let now = Math.floor(new Date().getTime() / 1000 );
                // 仮登録かつ既に有効期限切れ
                if (query_result_count[0].userRegistFlag == 0) {
                    // 仮登録ユーザーデータを削除し、作り直す
                    const deleteSql = `DELETE FROM User WHERE userEmail = ?`;
                    const [delete_query_result] = await mysql_con.execute(deleteSql, [emailAddress]);
                }
                else {
                    console.log("Already exists userId");
                    return {
                        statusCode: 400,
                        headers: {
                            "Access-Control-Allow-Origin": "*",
                            "Access-Control-Allow-Headers": "*",
                        },
                        body: JSON.stringify({
                            errorCode: 505,
                            message: "Duplicate entry"
                        }),
                    };
                }
            }
            // パスワードチェック
            if(!password.match(/^([ -~]{6,32})+$/)) {
                return {
                    statusCode: 400,
                    headers: {
                        'Access-Control-Allow-Origin': '*',
                        'Access-Control-Allow-Headers': '*',
                    },
                    body: JSON.stringify({
                        errorCode: 109,
                        message: "password regex error"
                    }),
                }
            }
            // Mail content & password content same
            if (emailAddress.localeCompare(password) === 0) {
                return {
                    statusCode: 400,
                    headers: {
                        'Access-Control-Allow-Origin': '*',
                        'Access-Control-Allow-Headers': '*',
                    },
                    body: JSON.stringify({
                        errorCode: 110,
                        message: "Email address and password cannot be the same."
                    }),
                }
            }
            // 重複登録チェック （同一IPから同じ時間帯に複数登録があった場合、弾く）
            const sourceIP = (event.requestContext.identity.sourceIp)?event.requestContext.identity.sourceIp:'';
            const userAgent = event.requestContext.identity.userAgent;
            const registTimestamp = Math.floor(new Date().getTime() / 1000);
            console.log("sourceIP", sourceIP);
            console.log("userAgent", userAgent);
            // blocklistのチェック, Here 1 means pattern type --> ipBlockPatternType
            const ipBlockKey = "ipblock:" + ENVID + ":1:list";
            const ipBlockConditionKey = "ipblock:" + ENVID + ":1:condition";
            const ipBlockPatternKey = `ipblockpattern:${ENVID}:1`;

            const ipBlockList = await cluster.zrange(ipBlockKey, registTimestamp, 9999999999, "BYSCORE");
            console.log("ipBlockList", ipBlockList);
            const conditionCount = ipBlockList.filter(member => (member == sourceIP));
            console.log("conditionCount", conditionCount.length);
            if (conditionCount.length >= 1) {
                console.error("重複登録エラー IPBlock", `${sourceIP}`);
                const checkDuplicateSql = `SELECT userCreatedAt FROM User WHERE userRegistIPAddress = ? AND userRegistFlag = 1 ORDER BY userCreatedAt DESC`;
                const [duplicatedQueryResult] = await mysql_con.execute(checkDuplicateSql, [sourceIP]);
                return {
                    statusCode: 400,
                    headers: {
                        "Access-Control-Allow-Origin": "*",
                        "Access-Control-Allow-Headers": "*",
                    },
                    body: JSON.stringify({
                        errorCode: 601,
                        message: "Duplicate entry",
                        ip: sourceIP,
                        userAgent: userAgent,
                        timestamp: [
                            duplicatedQueryResult
                        ]
                    }),
                };
            };
            const checkDuplicateSql = `SELECT userCreatedAt FROM User WHERE userRegistIPAddress = ? AND userRegistFlag = 1 ORDER BY userCreatedAt DESC`;
            const [duplicatedQueryResult] = await mysql_con.execute(checkDuplicateSql, [sourceIP]);
            // データがない場合そのIPで初めての登録なのでスルー
            if (duplicatedQueryResult && duplicatedQueryResult.length >= 1) {
                console.log("checkDuplicateSql", duplicatedQueryResult);
                let errorFlag = false;
                console.log("registTimestamp", registTimestamp);
                // for (let i = 0; i < duplicatedQueryResult.length; i++) {
                //     console.log("duplicatedQueryResult.userCreatedAt", duplicatedQueryResult[i].userCreatedAt);
                // }
                // // 条件１ 
                // const condition1Count = duplicatedQueryResult.filter(row => row.userCreatedAt >= registTimestamp - 180);
                // console.log("condition1Count", condition1Count.length);
                // if (condition1Count.length >= 13) {
                //     console.error("重複登録エラー 条件１", `${sourceIP}`);
                //     errorFlag = true;
                //     await cluster.zadd(ipBlockKey, registTimestamp + 1200, sourceIP);
                // }
                // else {
                //     // 条件２
                //     const condition1Count2 = duplicatedQueryResult.filter(row => row.userCreatedAt >= registTimestamp - 1200);
                //     console.log("condition1Count2", condition1Count2.length);
                //     if (condition1Count2.length >= 5) {
                //         console.error("重複登録エラー 条件２", `${sourceIP}`);
                //         errorFlag = true;
                //         await cluster.zadd(ipBlockKey, registTimestamp + 5400, sourceIP);
                //     }
                //     else {
                //         // 条件３
                //         const condition1Count3 = duplicatedQueryResult.filter(row => row.userCreatedAt >= registTimestamp - 5400);
                //         console.log("condition1Count3", condition1Count3.length);
                //         if (condition1Count3.length >= 8) {
                //             console.error("重複登録エラー 条件３", `${sourceIP}`);
                //             errorFlag = true;
                //             await cluster.zadd(ipBlockKey, registTimestamp + 21600, sourceIP);
                //         }
                //         else {
                //             // 条件４
                //             const condition1Count4 = duplicatedQueryResult.filter(row => row.userCreatedAt >= registTimestamp - 21600);
                //             console.log("condition1Count4", condition1Count4.length);
                //             if (condition1Count4.length >= 13) {
                //                 console.error("重複登録エラー 条件４", `${sourceIP}`);
                //                 errorFlag = true;
                //                 await cluster.zadd(ipBlockKey, registTimestamp + 43200, sourceIP);
                //             }
                //             else {
                //                 // 条件５
                //                 const condition1Count5 = duplicatedQueryResult.filter(row => row.userCreatedAt >= registTimestamp - 43200);
                //                 console.log("condition1Count5", condition1Count5.length);
                //                 if (condition1Count5.length >= 21) {
                //                     console.error("重複登録エラー 条件５", `${sourceIP}`);
                //                     errorFlag = true;
                //                     await cluster.zadd(ipBlockKey, registTimestamp + 86400, sourceIP);
                //                 }
                //                 else {
                //                     // 条件６
                //                     const condition1Count6 = duplicatedQueryResult.filter(row => row.userCreatedAt >= registTimestamp - 86400);
                //                     console.log("condition1Count6", condition1Count6.length);
                //                     if (condition1Count6.length >= 34) {
                //                         console.error("重複登録エラー 条件６", `${sourceIP}`);
                //                         errorFlag = true;
                //                         await cluster.zadd(ipBlockKey, registTimestamp + 604800, sourceIP);
                //                     }
                //                     else {
                //                         // 条件7
                //                         const condition1Count6 = duplicatedQueryResult.filter(row => row.userCreatedAt >= registTimestamp - 604800);
                //                         console.log("condition1Count6", condition1Count6.length);
                //                         if (condition1Count6.length >= 55) {
                //                             console.error("重複登録エラー 条件7", `${sourceIP}`);
                //                             errorFlag = true;
                //                             await cluster.zadd(ipBlockKey, registTimestamp + 259200, sourceIP);
                //                         }
                //                     }
                //                 }
                //             }
                //         }
                //     }
                // }

                const ipBlockPattern = await cluster.lrange(ipBlockPatternKey, 0, -1);
                
                for (let i = 0; i < ipBlockPattern.length; i++) {
                    const pattern = JSON.parse(ipBlockPattern[i]);

                    const conditionCount = duplicatedQueryResult.filter(row => row.userCreatedAt >= registTimestamp - pattern.inquiryUnixtime);
                    //console.log(`conditionCount${[i+1]}`, conditionCount);
                    console.log(`conditionCount length ${[i+1]}`, conditionCount.length);
                    if (conditionCount.length >= pattern.maxCount) {
                        console.error(`重複登録エラー 条件${[i+1]}`, `${sourceIP}`);
                        errorFlag = true;
                        await cluster.zadd(ipBlockKey, registTimestamp + pattern.blockUnixtime, sourceIP);
                        await cluster.zadd(ipBlockConditionKey, pattern.id, sourceIP);
                        break;
                    }
                }

                if (errorFlag) {
                    return {
                        statusCode: 400,
                        headers: {
                            "Access-Control-Allow-Origin": "*",
                            "Access-Control-Allow-Headers": "*",
                        },
                        body: JSON.stringify({
                            errorCode: 601,
                            message: "Duplicate entry",
                            ip: sourceIP,
                            userAgent: userAgent,
                            timestamp: [
                                duplicatedQueryResult
                            ]
                        }),
                    };
                }
            }

            //domainBlockImplemented #114317
            const getBlockDomainSql = `SELECT domainBlockPatternName, domainBlockPatternType FROM DomainBlockPattern`;
            const [domainBlockQueryResult] = await mysql_con.execute(getBlockDomainSql, []);
            
            if (domainBlockQueryResult && domainBlockQueryResult.length >= 1) {
                let blockFlag = false;
                //getBlockMails
                let domainEmails = domainBlockQueryResult.filter(mail=>{
                    if(mail.domainBlockPatternName.includes("@") && mail.domainBlockPatternName.split("@")[0]){
                        return true
                    }
                }).map(userMail=>userMail.domainBlockPatternName);
                //getBlockDomains
                let domains = domainBlockQueryResult.filter(mail=>{
                    if(mail.domainBlockPatternName.startsWith("@") || !mail.domainBlockPatternName.includes("@")){
                        return true
                    }
                }).map(userMail=>userMail.domainBlockPatternName);

                console.log("domainEmails",domainEmails);
                console.log("domains",domains);
                //checkUserMailsInBlockMails
                if(domainEmails.length>0 && domainEmails.includes(emailAddress.trim())){
                    //set blockFlag
                    blockFlag = true;
                }

                //checkDomainInBlockList
                let userMailAddress = emailAddress.trim();
                let getMailDomain = userMailAddress.split("@")[1];
                if(domains.length>0 && (domains.includes(getMailDomain) || domains.includes(`@${getMailDomain}`))){
                    //set blockFlag
                    blockFlag = true;
                }
                //checkBlockFlag
                if(blockFlag){
                    console.log("bloock this user to register");
                    return {
                        statusCode: 400,
                        headers: {
                            'Access-Control-Allow-Origin': '*',
                            'Access-Control-Allow-Headers': '*',
                        },
                        body: JSON.stringify({
                            errorCode: 602,
                            message: "Domain or email is block"
                        }),
                    }
                }
            }

            const insertUserSql = `
                INSERT INTO User(
                    userUUID,
                    userCountryId,
                    userLanguageId,
                    userEmail,
                    userPassword,
                    userRegistExpiredAt,
                    userRegistToken,
                    userInvitationCode,
                    userDirectionId,
                    userRegistIPAddress,
                    userCreatedAt,
                    userCreatedBy,
                    userUpdatedAt,
                    userUpdatedBy
                )
                VALUES(
                    UUID_TO_BIN(uuid()),
                    ?,
                    ?,
                    ?,
                    ?,
                    ?,
                    ?,
                    ?,
                    ?,
                    ?,
                    ?,
                    ?,
                    ?,
                    ?
                );
            `;
            const createdAt = Math.floor(new Date().getTime() / 1000);
            const expiredAt = Math.floor(new Date().getTime() / 1000 ) + (60 * 60 * 24); // １日後
            const registToken = randomString(128);
            const hashedPassword = await bcrypt.hashSync(password, 10);

            let sql_param = [
                DEFAULTCOUNTRYID, //CountryIdGetFromParamStore
                DEFAULTLANGUAGEID, //LanguageIdGetFromParamStore
                emailAddress.trim(),
                hashedPassword,
                expiredAt,
                registToken,
                (invitationCode)?invitationCode:null,
                DIRECTION,
                sourceIP,
                createdAt,
                '本人',
                createdAt,
                '本人',
            ];
            console.log("sql_param", sql_param);
            const [query_reqult] = await mysql_con.execute(insertUserSql, sql_param);
            // メールを発行
            const emailTemplateFrom = await cluster.get("system:" + ENVID + ":msm");
            let mailSubjectFromRedis = await cluster.get("system:" + ENVID + ":murt");//mailTitle
            let mailBodyFromRedis = await cluster.get("system:" + ENVID + ":murb");//mailBody
            let mailBodyAfterReplaceUrl = mailBodyFromRedis.replaceAll("{%URL%}",`${registURL}?token=${registToken}`);

            console.log("emailTemplateFrom",emailTemplateFrom);
            console.log("mailSubjectFromRedis",mailSubjectFromRedis);
            console.log("mailBodyAfterReplaceUrl",mailBodyAfterReplaceUrl);

            await exports.sendEmail(emailAddress, mailSubjectFromRedis, mailBodyAfterReplaceUrl, emailTemplateFrom);
            console.log('my response', response)
            return {
                statusCode: 200,
                headers: {
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Headers': '*',
                },
                body: JSON.stringify(response),
            }
        }
        else {
            console.log('my response', response)
            return {
                statusCode: 200,
                headers: {
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Headers': '*',
                },
                body: JSON.stringify(response),
            }
        }
    } catch (error) {
        console.error("error:", error)
        return {
            statusCode: 400,
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': '*',
            },
            body: JSON.stringify({
                errorCode: 501,
                message: "user create error"
            }),
        }
    } finally {
        if (mysql_con) await mysql_con.close();
    }
};
 
function randomString(len){
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    const randomArr = new Uint32Array(new Uint8Array(crypto.randomBytes(len * 4)).buffer);
    return [...randomArr].map(n => chars.charAt(n % chars.length)).join('');
}

exports.sendEmail = async (to, subject, body, source) => {
    console.log("==================== email")
    // E-mail setting
    let emailParams = {
        Destination: {
            ToAddresses: [to],
        },
        Message: {
            Subject: { Data: subject },
            Body: {
                Text: { Data: body },
            }
        },
        Source: source
    };

    let payload = JSON.stringify(emailParams);
    console.log(payload);
    let invokeParams = {
        FunctionName: "sendMail-" + process.env.ENV,
        InvocationType: "Event",
        Payload: payload
    };
    // invoke lambda
    let result = await lambda.invoke(invokeParams).promise();
    // console.log("==========result", result)
    if (result.$response.error) throw (500, result.$response.error.message);

    return result;
};