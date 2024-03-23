/**
 * @type {import('@types/aws-lambda').APIGatewayProxyHandler}
 */
const AWS = require('aws-sdk')
const mysql = require("mysql2/promise");
const ssm = new AWS.SSM();
const redis = require('ioredis');

const jwt = require('jsonwebtoken')
const jwtPattern = /^Bearer[ ]+([^ ]+)[ ]*$/i;

/**
 * ManagerAppRead.
 * 
 * @param {*} event 
 * @returns {json} response
 */
exports.handler = async (event) => {
    console.log("Event data:", event);
    console.log("event.Authorization", event.headers.Authorization);
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
        process.env.DIRECTION = dbinfo.DIRECTION;
        process.env.ACCESS_TOKEN_SECRET = dbinfo.ACCESS_TOKEN_SECRET;
    }
    const ENVID = process.env.ENVID;
    const DIRECTION = process.env.DIRECTION;
    const redisConfig = [
        {host: process.env.REDISPOINT1, port: 6379},
        {host: process.env.REDISPOINT2, port: 6379}
    ];
    const cluster = new redis.Cluster(
        redisConfig, 
        {
            dnsLookup: (address, callback) => callback(null, address),
            redisOptions: {tls: true}        
        }
    );

    try {
        // TODO
        let languageCode = event.queryStringParameters?.l? event.queryStringParameters.l: await cluster.get("language:" + ENVID + ":default");
        console.log("languageCode", languageCode);
        let translateId = await cluster.get("language:" + ENVID + ":" + languageCode);
        let translateJaId = await cluster.get("language:" + ENVID + ":ja");
        console.log("translateId", translateId);
        const now = Math.floor((new Date(Date.now()).getTime()) / 1000);

        //getUserIdToUpdateUserActivities
        // jwtからユーザーIDを取得
        const result = await getUserId();
        const { success, userId, statusCode } = result || {};
        
        if(userId){
            await cluster.zadd("user:" + ENVID + ":activities", now, userId);
        }

        if (event.pathParameters?.gachaId) {
            let gachaId = event.pathParameters.gachaId;
            gachaId = (gachaId.startsWith("p-"))?gachaId.slice(2):gachaId;
            let gachainfo = JSON.parse(await cluster.get("gacha:" + ENVID + ":" + gachaId + ":" + translateId + ":info"));
            if (gachainfo) {
                // console.log("gachainfo", gachainfo);
                // ガチャの残数のセット
                gachainfo.gachaRemainingCount = Number(await cluster.llen("gacha:" + ENVID + ":" + gachaId + ":list"));
                // console.log("gachainfo.gachaId", gachainfo.gachaId);
            }
            else {
                gachainfo = JSON.parse(await cluster.get("gacha:" + ENVID + ":" + gachaId + ":" + translateJaId + ":info"));
                if (gachainfo) {
                    // console.log("gachainfo", gachainfo);
                    // ガチャの残数のセット
                    gachainfo.gachaRemainingCount = Number(await cluster.llen("gacha:" + ENVID + ":" + gachaId + ":list"));
                    // console.log("gachainfo.gachaId", gachainfo.gachaId);
                }
            }
            // 見れる範囲かどうかチェック
            if (gachainfo && gachainfo.gachaPostStartDate >= now && gachainfo.gachaDirectionId == DIRECTION && (gachainfo.gachaSoldOutFlag == 1 || (gachainfo.gachaSoldOutFlag == 0 && gachainfo.gachaRemainingCount >= 1))) {
                // 個人天井　ログインしている場合
                if (event.headers.Authorization && event.headers.Authorization != null && event.headers.Authorization != "Bearer null" && event.headers.Authorization != "Bearer undefined") {
                    // トークン
                    const token = jwtPattern.exec(event.headers.Authorization)[1];
                    console.log("token", token);
                    // JWT解析
                    try {
                        const decoded = await jwt.verify(token, process.env.ACCESS_TOKEN_SECRET);
                        if (decoded != null) {
                            let userId = decoded.userId;
                            // limit = await cluster.get("user:" + ENVID + ":" + userId + ":" + gachaId + ":limit");
                            gachainfo.gachaMyLimitCount = Number(await cluster.get("user:" + ENVID + ":" + userId + ":" + gachaId + ":limit"));
                        }
                    }
                    catch (e) {
                    }
                }
                const gachaData = {};
                gachaData["p-" + gachaId] = gachainfo;
                let response = {
                    "gachaData": gachaData
                }
                return {
                    statusCode: 200,
                    headers: {
                        'Access-Control-Allow-Origin': '*',
                        'Access-Control-Allow-Headers': '*',
                    },
                    body: JSON.stringify({response}),
                }
            }
            else {
                let response = {
                    "gachaData": []
                }
                return {
                    statusCode: 200,
                    headers: {
                        'Access-Control-Allow-Origin': '*',
                        'Access-Control-Allow-Headers': '*',
                    },
                    body: JSON.stringify({response}),
                }
            }
        }
        else {
            // ガチャ一覧の返却
            let gachaList = {};
            let userId = "";
            // 個人天井　ログインしている場合
            if (event.headers.Authorization && event.headers.Authorization != null && event.headers.Authorization != "Bearer null" && event.headers.Authorization != "Bearer undefined") {
                try {
                    // トークン
                    const token = jwtPattern.exec(event.headers.Authorization)[1];
                    console.log("token", token);
                    // JWT解析
                    const decoded = await jwt.verify(token, process.env.ACCESS_TOKEN_SECRET);
                    if (decoded != null) {
                        userId = decoded.userId;
                    }
                }
                catch (e) {
                }
            }
            // console.log("ENVID","gachalist" + ENVID);
            // console.log("llen gacha", await cluster.llen("gachalist:" + ENVID));
            for (let i = 0; i < await cluster.llen("gachalist:" + ENVID); i++) {
                let gachaId = await cluster.lrange("gachalist:" + ENVID, i, i);
                console.log("gachalist gachaId = ", gachaId);
                console.log("gachalist gacha = ", "gacha:" + ENVID + ":" + gachaId + ":" + translateId + ":info");
                const gachainfo = JSON.parse(await cluster.get("gacha:" + ENVID + ":" + gachaId + ":" + translateId + ":info"));
                if (gachainfo) {
                    if (gachainfo.gachaDirectionId == DIRECTION) {
                        gachainfo.gachaRemainingCount = Number(await cluster.llen("gacha:" + ENVID + ":" + gachaId + ":list"));
                        if (userId) gachainfo.gachaMyLimitCount = Number(await cluster.get("user:" + ENVID + ":" + userId + ":" + gachaId + ":limit"));
                        gachaList["p-" + gachainfo.gachaId] = gachainfo;
                        // gachaList.push(gachainfo);
                    }
                }
                else {
                    const gachainfo2 = JSON.parse(await cluster.get("gacha:" + ENVID + ":" + gachaId + ":" + translateJaId + ":info"));
                    if (gachainfo2) {
                        if (gachainfo2.gachaDirectionId == DIRECTION) {
                            gachainfo2.gachaRemainingCount = Number(await cluster.llen("gacha:" + ENVID + ":" + gachaId + ":list"));
                            if (userId) gachainfo2.gachaMyLimitCount = Number(await cluster.get("user:" + ENVID + ":" + userId + ":" + gachaId + ":limit"));
                            gachaList["p-" + gachainfo2.gachaId] = gachainfo2;
                            // gachaList.push(gachainfo2);
                        }
                    }
                }
            }
/*
            // 個人天井　ログインしている場合
            if (event.headers.Authorization && event.headers.Authorization != null && event.headers.Authorization != "Bearer null" && event.headers.Authorization != "Bearer undefined") {
                // トークン
                const token = jwtPattern.exec(event.headers.Authorization)[1];
                console.log("token", token);
                // JWT解析
                const decoded = await jwt.verify(token, process.env.ACCESS_TOKEN_SECRET);
                if (decoded != null) {
                    let userId = decoded.userId;
                    (async () => {
                        console.log("xxxxxxxxxxxxxxxxxxxxx 1");
                        await Object.keys(gachaList).forEach(async key => {
                            gachaList[key].gachaMyLimitCount = Number(await cluster.get("user:" + ENVID + ":" + userId + ":" + gachaList[key].gachaId + ":limit"));
                            console.log("xxxxxxxxxxxxxxxxxxxxx 2", gachaList[key]);
                        });
                    })();
                    console.log("xxxxxxxxxxxxxxxxxxxxx 3");
                }
            }
*/
            console.log("gachaList", gachaList);
            let response = {
                gachaList: gachaList
            }
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
            body: JSON.stringify(error),
        }
    } finally {
        // if (mysql_con) await mysql_con.close();
    }

    async function getUserId() {
        // ログインしている必要あり
        if (event.headers.Authorization && event.headers.Authorization != null && event.headers.Authorization != "Bearer null") {
            // トークン
            const token = jwtPattern.exec(event.headers.Authorization)[1];
            console.log("token", token);
            const decoded = await jwt.verify(token, process.env.ACCESS_TOKEN_SECRET);
            if (decoded == null) {
                console.error("JWTが解析できない");
                return { success: false, statusCode: 103 }
            }
            console.log("decoded", decoded);
            let userId = decoded.userId;

            return { success: true, userId, statusCode: 200 }
        }
        // ログインしていない
        console.error("ログインしていない");
        return { success: false, statusCode: 101 }
    }
};