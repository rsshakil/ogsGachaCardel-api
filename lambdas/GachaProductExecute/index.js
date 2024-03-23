/**
 * @type {import('@types/aws-lambda').APIGatewayProxyHandler}
 */
const AWS = require('aws-sdk')
const mysql = require("mysql2/promise");
const ssm = new AWS.SSM();
const redis = require('ioredis');
const { v4: uuidv4 } = require('uuid');
const SqsExtendedClient = require('sqs-extended-client');

const jwt = require('jsonwebtoken')
const jwtPattern = /^Bearer[ ]+([^ ]+)[ ]*$/i;

const sqs = new AWS.SQS();
const queueUrl = `https://sqs.ap-northeast-1.amazonaws.com/225702177590/PointSQS-${process.env.ENV}.fifo`;
const queueUrl2 = `https://sqs.ap-northeast-1.amazonaws.com/225702177590/InventorySQS-${process.env.ENV}.fifo`;
const queueUrl3 = `https://sqs.ap-northeast-1.amazonaws.com/225702177590/OripaSQS-${process.env.ENV}.fifo`;
const queueUrl4 = `https://sqs.ap-northeast-1.amazonaws.com/225702177590/EmissionSQS-${process.env.ENV}.fifo`;
const lambda = new AWS.Lambda();

const DEFAULT_MESSAGE_SIZE_THRESHOLD = 262144; //bytes
const extendedClient = new SqsExtendedClient({
    bucketName: `sqs-message-payloads-${process.env.ENV}`,
    messageSizeThreshold: DEFAULT_MESSAGE_SIZE_THRESHOLD
});

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
        process.env.VIDEOURLH265 = dbinfo.VIDEOURLH265;
        process.env.VIDEOURLMP4 = dbinfo.VIDEOURLMP4;
        process.env.VIDEOURLWEBM = dbinfo.VIDEOURLWEBM;
        process.env.ACCESS_TOKEN_SECRET = dbinfo.ACCESS_TOKEN_SECRET;
    }
    const ENVID = process.env.ENVID;
    let writeDbConfig = {
        host: process.env.DBWRITEENDPOINT,
        user: process.env.DBUSER,
        password: process.env.DBPASSWORD,
        database: process.env.DBDATABSE,
        charset: process.env.DBCHARSET,
    };
    const redisConfig = [
        { host: process.env.REDISPOINT1, port: 6379 },
        { host: process.env.REDISPOINT2, port: 6379 }
    ];
    let mysql_con;
    const cluster = new redis.Cluster(
        redisConfig,
        {
            dnsLookup: (address, callback) => callback(null, address),
            redisOptions: { tls: true }
        }
    );
    let gachaId;
    let lockFlag = false;
    let now = Math.floor(new Date().getTime() / 1000);
    // 配送日時

    try {
        let userCollectionShippedAt = Number(await cluster.get("system:" + ENVID + ":sd"));
        console.log("event.headers.Authorization", event.headers.Authorization);
        // ログインしている必要あり
        if (event.headers.Authorization && event.headers.Authorization != null && event.headers.Authorization != "Bearer null" && event.headers.Authorization != "Bearer undefined") {
            console.log("user data exists!");
            if (event?.pathParameters.gachaId) {
                // ガチャID
                gachaId = event.pathParameters.gachaId;
                gachaId = (gachaId.startsWith("p-")) ? gachaId.slice(2) : gachaId;
                console.log("<<gachaId>>", gachaId); //Do not delete the log. It is using to detect time out exception
                // 日本語ID
                const translateJpId = await cluster.get("language:" + ENVID + ":ja");
                // パラメーター
                const body = JSON.parse(event.body);
                // ガチャ引きパターン 
                const pattern = body?.pattern ? body.pattern : 1;
                const gachaToken = body?.gachaToken ? body.gachaToken : undefined;

                // トークン
                const token = jwtPattern.exec(event.headers.Authorization)[1];
                console.log("token", token);
                // JWT解析
                let decoded;
                try {
                    decoded = await jwt.verify(token, process.env.ACCESS_TOKEN_SECRET);
                } catch (e) { }
                if (decoded == null) {
                    console.error("JWTが解析できない");
                    throw new Error(101); // 仮
                    // throw new Error(103);
                }
                else {
                    console.log("decoded", decoded);
                    // let decodeData = JSON.parse(decoded);
                    let decodeData = decoded;
                    let userId = decodeData.userId;

                    //Verify the gachaToken is valid or not before execute
                    const redisGachaToken = await cluster.get("user:" + ENVID + ":" + userId + ":gachatoken");

                    /*
                    if (redisGachaToken != gachaToken) {
                        console.error('redisGachaToken and incoming gachaToken are not matched!');
                        console.error('redisGachaToken', redisGachaToken);
                        console.error('gachaToken', gachaToken);
                        throw new Error(403);
                    }
                    */

                    const gachaInfo = JSON.parse(await cluster.get("gacha:" + ENVID + ":" + gachaId + ":" + translateJpId + ":info"));
                    console.log("gachaInfo", gachaInfo);
                    if (!gachaInfo) {
                        console.error("無効なガチャが対象");
                        throw new Error(205);
                    }
                    // 国民チェック
                    const userCountry = await cluster.get("user:" + ENVID + ":" + userId + ":country");
                    if (!userCountry || userCountry == "0") {
                        console.error("国が選択されていない");
                        throw new Error(104);
                    }
                    // ガチャが有効か？
                    if (gachaInfo.gachaViewFlag != 1) {
                        console.error("ガチャが表示エラー対象");
                        throw new Error(206);
                    }

                    // ガチャが有効期限内か？
                    if (!(now >= (gachaInfo.gachaStartDate / 1000) && now <= (gachaInfo.gachaEndDate / 1000))) {
                        console.error("ガチャが期限内ではない");
                        throw new Error(207);
                    }

                    // ロックチェック ロックがかかってなかったらロックをする
                    const lockResult = await cluster.setnx(["gacha:" + ENVID + ":" + gachaId + ":lock", "lock"]);
                    // ロックされているか？
                    if (!lockResult) {
                        console.error("ロックされている");
                        throw new Error(202);
                    }
                    lockFlag = true;
                    // ガチャ残り数
                    console.log("key = ", "gacha:" + gachaId + ":list")
                    const gachaRemainingCount = Number(await cluster.llen("gacha:" + ENVID + ":" + gachaId + ":list"));

                    // パターン
                    // 1 = 1回
                    // 2 = 連続（デフォルト10回）
                    // 3 = 残り全部
                    let costPoint = 9999999999;
                    let execNum = 0; // 回転数
                    switch (pattern) {
                        // 消費ポイント（1回）
                        case 1:
                        default:
                            costPoint = gachaInfo.gachaSinglePoint;
                            execNum = 1; break;
                        case 2:
                            costPoint = gachaInfo.gachaConosecutivePoint;
                            execNum = gachaInfo.gachaConosecutiveCount; break;
                        case 3:
                            costPoint = gachaInfo.gachaSinglePoint * gachaRemainingCount;
                            execNum = gachaRemainingCount; break;
                    }
                    // パターンが有効かチェック（残り全部がありか確認）
                    if (pattern == 3) {
                        if (gachaRemainingCount > gachaInfo.gachaAllRestCount) {
                            console.error("残り全部の枚数不正");
                            throw new Error(208);
                        }
                    }


                    // ガチャが１人１日上限数に引っかかっていないか
                    // 実行成功 pipeline
                    const successPipeline = cluster.pipeline();
                    // 一日制限が存在するか？
                    if (gachaInfo.gachaLimitOncePerDay && gachaInfo.gachaLimitOncePerDay >= 1) {
                        console.log("gachaInfo.gachaLimitOncePerDay", gachaInfo.gachaLimitOncePerDay);
                        let checkFlag = false;
                        let myLimit = 0;
                        // 制限数分ループ
                        mainLoop: for (let i = 1; i <= gachaInfo.gachaLimitOncePerDay; i++) {
                            // 存在しない
                            if (!await cluster.sismember("gacha:" + ENVID + ":" + gachaId + ":" + i + ":limit1", userId)) {
                                // 引く枚数 より　残り制限数の方が小さい
                                if (execNum <= (gachaInfo.gachaLimitOncePerDay - i + 1)) {
                                    for (let j = i; j < (execNum + i); j++) {
                                        await successPipeline.sadd("gacha:" + ENVID + ":" + gachaId + ":" + j + ":limit1", userId);
                                    }
                                    checkFlag = true;
                                    break mainLoop;
                                }
                                else {
                                    myLimit = gachaInfo.gachaLimitOncePerDay - i + 1 + execNum;
                                    break;
                                }
                            }
                            myLimit = i;
                        }
                        // フラグがfalseのままならエラー
                        if (!checkFlag) {
                            // まだ引く余地はあるかチェック
                            // 引く余地がない
                            if ((gachaInfo.gachaLimitOncePerDay - myLimit) == 0) {
                                console.error("ガチャが１人１日上限数に引っかかっている");
                                throw new Error(301);
                            }
                            // 引く余地がある
                            else {
                                console.error("ガチャが１人１日上限数に引っかかっている まだ単発なら引ける");
                                throw new Error(304);
                            }
                        }
                    }
                    // ガチャが１人上限数に引っかかっていないか
                    if (gachaInfo.gachaLimitOnce && gachaInfo.gachaLimitOnce >= 1) {
                        console.log("gachaInfo.gachaLimitOnce", gachaInfo.gachaLimitOnce);
                        let checkFlag = false;
                        let myLimit = 0;
                        // 制限数分ループ
                        mainLoop: for (let i = 1; i <= gachaInfo.gachaLimitOnce; i++) {
                            // 存在しない
                            if (!await cluster.sismember("gacha:" + ENVID + ":" + gachaId + ":" + i + ":limit3", userId)) {
                                // 引く枚数 より　残り制限数の方が小さい
                                if (execNum <= (gachaInfo.gachaLimitOnce - i + 1)) {
                                    for (let j = i; j < (execNum + i); j++) {
                                        await successPipeline.sadd("gacha:" + ENVID + ":" + gachaId + ":" + j + ":limit3", userId);
                                    }
                                    checkFlag = true;
                                    break mainLoop;
                                }
                                else {
                                    myLimit = gachaInfo.gachaLimitOnce - i + 1 + execNum;
                                    break;
                                }
                            }
                            myLimit = i;
                        }
                        // フラグがfalseのままならエラー
                        if (!checkFlag) {
                            // まだ引く余地はあるかチェック
                            // 引く余地がない
                            if ((gachaInfo.gachaLimitOnce - myLimit) == 0) {
                                console.error("ガチャが１人上限数に引っかかっている");
                                throw new Error(303);
                            }
                            // 引く余地がある
                            else {
                                console.error("ガチャが１人上限数に引っかかっている まだ単発なら引ける");
                                throw new Error(306);
                            }
                        }
                    }
                    // ガチャが全員１日上限数に引っかかっていないか
                    if (gachaInfo.gachaLimitEveryonePerDay && gachaInfo.gachaLimitEveryonePerDay >= 1) {
                        // 現在の制限数を取得
                        const limitCount = (await cluster.get("gacha:" + ENVID + ":" + gachaId + ":limit2")) ? Number(await cluster.get("gacha:" + ENVID + ":" + gachaId + ":limit2")) : 0;
                        console.log("limitCount", limitCount);
                        if (limitCount >= gachaInfo.gachaLimitEveryonePerDay) {
                            console.error("ガチャが全員１日上限数に引っかかっている");
                            throw new Error(302);
                        }
                        else {
                            console.log("(execNum + limitCount)", (execNum + limitCount));
                            console.log("execNum", execNum);
                            if ((execNum + limitCount) > gachaInfo.gachaLimitEveryonePerDay) {
                                console.error("ガチャが全員１日上限数に引っかかっている まだ単発なら引ける");
                                throw new Error(305);
                            }
                            else {
                                await successPipeline.set("gacha:" + ENVID + ":" + gachaId + ":limit2", limitCount + execNum);
                            }
                        }
                    }

                    // 自分のポイント
                    let myPoint = Number(await cluster.get("user:" + ENVID + ":" + userId + ":pt"));
                    // ポイントの比較
                    if (costPoint > myPoint) {
                        console.error("ポイントが足りない", "user:" + ENVID + ":" + userId + ":pt");
                        console.log("myPoint", myPoint);
                        console.log("costPoint", costPoint);
                        throw new Error(201);
                    }
                    console.log("gachaRemainingCount", gachaRemainingCount);
                    console.log("execNum", execNum);
                    // 現在引く枚数以上あるか？
                    if (gachaRemainingCount == 0 || gachaRemainingCount < execNum) {
                        console.error("枚数が足りない");
                        throw new Error(203);
                    }

                    // @@@@@@ ポイント減算処理
                    // 1. ポイント減算SQSを発行する TODO
                    //SQS Processing
                    const params = {
                        MessageBody: JSON.stringify({ userId: userId, point: costPoint, detailStatus: 2, executeAt: Math.floor(new Date().getTime() / 1000) }),
                        QueueUrl: queueUrl,
                        MessageGroupId: "POINTSQS_EXECUTE",
                        MessageDeduplicationId: uuidv4(),
                    };
                    const sqsResult = await sqs.sendMessage(params).promise();
                    console.log("Message published successfully");
                    if (!sqsResult) {
                        console.error("SQS発行エラー 1");
                        throw new Error(204);
                    }
                    // 2. redisから直接ポイントを減算する
                    await successPipeline.set("user:" + ENVID + ":" + userId + ":pt", myPoint - costPoint);

                    // @@@@@@ ガチャ処理開始
                    let cardBox = [];
                    // 通常処理
                    if (!gachaInfo.gachaLoopFlag) {
                        console.log("loopガチャではない");
                        for (let i = 0; i < execNum; i++) {
                            cardBox.push(await cluster.lpop("gacha:" + ENVID + ":" + gachaId + ":list"));
                        }
                    }
                    // ループ処理
                    else {
                        for (let i = 0; i < execNum; i++) {
                            cardBox.push(await cluster.lpop("gacha:" + ENVID + ":" + gachaId + ":list"));
                        }
                        console.log("loopガチャである", cardBox.length);
                        const pipelineLoop = await cluster.pipeline();
                        // 引いた後にもう一度後ろに追加する
                        for (let i = 0; i < cardBox.length; i++) {
                            console.log("IN");
                            pipelineLoop.rpush("gacha:" + ENVID + ":" + gachaId + ":list", cardBox[i]);
                        }
                        pipelineLoop.exec();
                        console.log("count gacha", await cluster.llen("gacha:" + ENVID + ":" + gachaId + ":list"));
                    }
                    console.log("cardBox", cardBox);
                    const emissionPosition = gachaInfo.gachaTotalCount - await cluster.llen("gacha:" + ENVID + ":" + gachaId + ":list");
                    // ロック解除
                    await cluster.del("gacha:" + ENVID + ":" + gachaId + ":lock");
                    await successPipeline.exec();
                    let result = [];
                    let insertSql = `INSERT INTO UserCollection(
                        userCollectionUserId, 
                        userCollectionItemId,
                        userCollectionPoint,
                        userCollectionEmissionId,
                        userCollectionCreatedAt,
                        userCollectionUpdatedAt,
                        userCollectionExpiredAt
                    ) VALUES`;
                    let insertValues = '';
                    let insertParam = [];
                    let updateParam = [];
                    // 在庫更新SQS用
                    let emissionItemIds = [];

                    // 天井賞が存在する場合以下のフローに進む
                    let limitBonus = {};
                    let limitVideoId = 0;
                    let emissionIds = []; // CSV用
                    if (gachaInfo.gachaLimitCount != 0) {
                        // 個人天井の取得
                        let myLimit = await cluster.get("user:" + ENVID + ":" + userId + ":" + gachaId + ":limit");
                        // 個人天井リセット
                        let limitResetPrizeId = JSON.parse(await cluster.get("gacha:" + ENVID + ":" + gachaId + ":limitreset"));
                        for (let i = 0; i < cardBox.length; i++) {
                            const row = JSON.parse(cardBox[i]);
                            let matchFlag = false
                            for (let j = 0; j < limitResetPrizeId.length; j++) {
                                // マッチした場合個人天井をリセットする
                                matchFlag = false
                                if (limitResetPrizeId[j] == row.pi) {
                                    // console.log("limit reset limitResetPrizeId = ", limitResetPrizeId[j]);
                                    // console.log("limit reset ipi = ", row.ipi);
                                    matchFlag = true;
                                    break;
                                }
                            }
                            // matchFlagがtrueだったらリセットする
                            if (matchFlag) {
                                myLimit = 0;
                            }
                            else {
                                myLimit++;
                            }
                            // 一度でも超えれば抜ける
                            if (gachaInfo.gachaLimitCount <= myLimit) {
                                break;
                            }
                        }
                        // myLimitを更新
                        await cluster.set("user:" + ENVID + ":" + userId + ":" + gachaId + ":limit", myLimit);
                        // このガチャを既に回したことがある
                        // if (myLimit && myLimit >= 1) {
                        //     await cluster.set("user:" + ENVID + ":" + userId + ":" + gachaId + ":limit", Number(myLimit) + execNum);
                        //     myLimit = Number(myLimit) + execNum;
                        // }
                        // 初めてこのガチャを回した 
                        // else {
                        // await cluster.set("user:" + ENVID + ":" + userId + ":" + gachaId + ":limit", execNum);
                        // myLimit = execNum;
                        // }
                        // 個人天井に達したかチェック
                        console.log("gachaLimitCount", gachaInfo.gachaLimitCount);
                        console.log("myLimit", myLimit);
                        if (gachaInfo.gachaLimitCount <= myLimit) {
                            const limitItemInfo = JSON.parse(await cluster.lpop("gacha:" + ENVID + ":" + gachaId + ":limit:list"));
                            console.log("limitItemInfo", limitItemInfo);
                            const limitBonusItem = JSON.parse(await cluster.get("item:" + ENVID + ":" + limitItemInfo.bi + ":1:info")); // TODO 日本語
                            console.log("limitBonusItem", limitBonusItem);
                            limitBonus = {
                                itemUUID: limitItemInfo.uuid,
                                itemId: Number(limitItemInfo.bi),
                                itemName: limitBonusItem.itemName,
                                itemPoint: Number(limitItemInfo.bp),
                                itemImagePath1: limitBonusItem.itemImagePath1,
                                itemDescription1: limitBonusItem.itemDescription1,
                                itemDescription2: limitBonusItem.itemDescription2,
                                itemAttribute1: limitBonusItem.itemAttribute1,
                                itemAttribute2: limitBonusItem.itemAttribute2,
                                itemAttribute3: limitBonusItem.itemAttribute3,
                                itemAttribute4: limitBonusItem.itemAttribute4,
                                itemAttribute5: limitBonusItem.itemAttribute5,
                                itemAttribute6: limitBonusItem.itemAttribute6,
                                itemAttribute7: limitBonusItem.itemAttribute7,
                                itemAttribute8: limitBonusItem.itemAttribute8,
                                isItemSelected: false,
                                itemShippingFlag: limitBonusItem.itemShippingFlag,
                                emissionId: limitItemInfo.eid,
                                shippingRequestDeadline: (now + userCollectionShippedAt) * 1000
                            }
                            result.push(limitBonus);
                            // 天井賞は一枚だけ
                            await cluster.set("user:" + ENVID + ":" + userId + ":" + gachaId + ":limit", 0);
                            // 天井賞がDBに追加されている？？ TODO
                            if (insertValues == '') insertValues += `(?, ?, ?, ?, ?, ?, ?)`;
                            else insertValues += `,(?, ?, ?, ?, ?, ?, ?)`;
                            insertParam.push(userId);
                            insertParam.push(Number(limitItemInfo.bi));
                            insertParam.push(Number(limitItemInfo.bp));
                            insertParam.push(Number(limitItemInfo.eid));
                            insertParam.push(now);
                            insertParam.push(now);
                            insertParam.push(now + userCollectionShippedAt);
                            updateParam.push(Number(limitItemInfo.bi));
                            // SQS
                            emissionItemIds.push(Number(limitItemInfo.bi));
                            limitVideoId = limitItemInfo.vi;
                            emissionIds.push(limitItemInfo.eid);
                        }
                    }

                    // ガチャ結果配列を作成する
                    // 一緒にデータベースのコレクションに追加する
                    let videoUrl;
                    let videoKey;
                    let videoPriority = 0;
                    let videoId = 0;
                    for (let i = 0; i < cardBox.length; i++) {
                        // insertValues = '';
                        const row = JSON.parse(cardBox[i]);
                        if (videoPriority <= row.vp) {
                            videoPriority = row.vp;
                            videoId = row.vi;
                        }
                        console.log("row", row);
                        const itemData = JSON.parse(await cluster.get("item:" + ENVID + ":" + row.ii + ":" + translateJpId + ":info")); // TODO 強制的に日本語
                        const bonusItemData = JSON.parse(await cluster.get("item:" + ENVID + ":" + row.bi + ":" + translateJpId + ":info")); // TODO 強制的に日本語
                        console.log("item:" + ENVID + ":" + row.ii + ":1:info");
                        // console.log("row.bi", row.bi);
                        console.log("itemData", itemData);
                        // console.log("itemData.itemUUID", itemData.itemUUID);
                        let resultItemJson = {
                            itemUUID: row.uuid,
                            itemId: Number(row.ii),
                            itemName: itemData.itemName,
                            itemPoint: Number(row.ip),
                            itemImagePath1: itemData.itemImagePath1,
                            itemDescription1: itemData.itemDescription1,
                            itemDescription2: itemData.itemDescription2,
                            itemAttribute1: itemData.itemAttribute1,
                            itemAttribute2: itemData.itemAttribute2,
                            itemAttribute3: itemData.itemAttribute3,
                            itemAttribute4: itemData.itemAttribute4,
                            itemAttribute5: itemData.itemAttribute5,
                            itemAttribute6: itemData.itemAttribute6,
                            itemAttribute7: itemData.itemAttribute7,
                            itemAttribute8: itemData.itemAttribute8,
                            isItemSelected: false,
                            itemShippingFlag: itemData.itemShippingFlag,
                            emissionId: row.eid,
                            shippingRequestDeadline: (now + userCollectionShippedAt) * 1000

                            // unable2Ship : true,//now its static need to get it from redis
                            // pointExchange : 55,//now its static need to get it from redis
                            // emissionUUID : '550e8400-e29b-41d4-a716-446655440000',//now its static need to get it from redis
                            // shippingRequestDeadline : new Date(2023, 12, 15)//now its static need to get it from redis
                        };
                        if (insertValues == '') insertValues += `(?, ?, ?, ?, ?, ?, ?)`;
                        else insertValues += `,(?, ?, ?, ?, ?, ?, ?)`;
                        insertParam.push(userId);
                        insertParam.push(Number(row.ii));
                        insertParam.push(Number(row.ip));
                        insertParam.push(Number(row.eid));
                        insertParam.push(now);
                        insertParam.push(now);
                        insertParam.push(now + userCollectionShippedAt);
                        updateParam.push(Number(row.ii));
                        result.push(resultItemJson);
                        // SQS
                        emissionItemIds.push(Number(row.ii));
                        if (row.bi != 0) {
                            console.log("item:" + ENVID + ":" + row.bi + ":" + translateJpId + ":info"); // TODO 強制的に日本語
                            console.log("bonusItemData", bonusItemData);
                            let resultBonusItemJson = {
                                itemUUID: row.uuid,
                                itemId: Number(row.bi),
                                itemName: bonusItemData.itemName,
                                itemPoint: Number(row.bp),
                                itemImagePath1: bonusItemData.itemImagePath1,
                                itemDescription1: bonusItemData.itemDescription1,
                                itemDescription2: bonusItemData.itemDescription2,
                                itemAttribute1: bonusItemData.itemAttribute1,
                                itemAttribute2: bonusItemData.itemAttribute2,
                                itemAttribute3: bonusItemData.itemAttribute3,
                                itemAttribute4: bonusItemData.itemAttribute4,
                                itemAttribute5: bonusItemData.itemAttribute5,
                                itemAttribute6: bonusItemData.itemAttribute6,
                                itemAttribute7: bonusItemData.itemAttribute7,
                                itemAttribute8: bonusItemData.itemAttribute8,
                                isItemSelected: false,
                                itemShippingFlag: bonusItemData.itemShippingFlag,
                                emissionId: row.eid,
                                shippingRequestDeadline: (now + userCollectionShippedAt) * 1000
                                // unable2Ship : true,//now its static need to get it from redis
                                // pointExchange : 55,//now its static need to get it from redis
                                // emissionUUID : '550e8400-e29b-41d4-a716-446655440000',//now its static need to get it from redis
                                // shippingRequestDeadline : new Date(2023, 12, 15)//now its static need to get it from redis
                            };
                            if (insertValues == '') insertValues += `(?, ?, ?, ?, ?, ?, ?)`;
                            else insertValues += `,(?, ?, ?, ?, ?, ?, ?)`;
                            // insertParam = [userId, Number(row.ii), Number(row.ip), now, now, now];
                            insertParam.push(userId);
                            insertParam.push(Number(row.bi));
                            insertParam.push(Number(row.bp));
                            insertParam.push(Number(row.eid));
                            insertParam.push(now);
                            insertParam.push(now);
                            insertParam.push(now + userCollectionShippedAt);
                            updateParam.push(Number(row.bi));
                            result.push(resultBonusItemJson);
                            // SQS
                            emissionItemIds.push(Number(row.bi));
                        }
                        emissionIds.push(row.eid);
                    }
                    // 天井賞があった場合動画が変わらなければならない
                    if (limitVideoId) {
                        videoUrl = await cluster.get("video:" + ENVID + ":" + limitVideoId + ":url");
                        videoKey = await cluster.get("video:" + ENVID + ":" + limitVideoId + ":key");
                    }
                    else {
                        videoUrl = await cluster.get("video:" + ENVID + ":" + videoId + ":url");
                        videoKey = await cluster.get("video:" + ENVID + ":" + videoId + ":key");
                    }
                    console.log("videoPriority", videoPriority);
                    console.log("limitVideoId", limitVideoId);
                    console.log("videoId", videoId);
                    console.log("videoUrl", videoUrl);
                    // コレクション追加SQLの実行
                    mysql_con = await mysql.createConnection(writeDbConfig);
                    insertSql += insertValues;
                    await mysql_con.beginTransaction();
                    console.log("insertSql", insertSql);
                    console.log("insertParam", insertParam);
                    const userCollectionInserResult = await mysql_con.execute(insertSql, insertParam);

                    //Hasanul changes start
                    //After insert multiple records get the affectedRows & insertId then get all inserted records for the specific user then push the 
                    //userCollectionId into result
                    console.log('my response ->>>>>', userCollectionInserResult);
                    const { affectedRows = 0, insertId = undefined } = userCollectionInserResult[0] || {};

                    if (affectedRows > 0 && insertId != undefined) {
                        const get_inserted_usercollection_sql = `SELECT * FROM UserCollection WHERE userCollectionId >= ? AND userCollectionUserId = ? AND userCollectionEmissionId IN (?) LIMIT ${affectedRows}`;

                        const emissionIds = result.map(x => x.emissionId);

                        const [get_inserted_usercollection_data] = await mysql_con.query(get_inserted_usercollection_sql, [insertId, userId, emissionIds]);

                        if (get_inserted_usercollection_data.length > 0) {
                            result = result.map(x => {
                                const foundItem = get_inserted_usercollection_data.find(y => y.userCollectionEmissionId == x.emissionId && y.userCollectionItemId == x.itemId);
                                x.userCollectionId = foundItem.userCollectionId;
                                return x;
                            })
                        }
                    }

                    mysql_con.commit();

                    console.log("now", now);
                    console.log("userCollectionShippedAt", userCollectionShippedAt);
                    console.log("now + userCollectionShippedAt", now + userCollectionShippedAt);

                    // 在庫変動をSQSに
                    const params2 = {
                        MessageBody: JSON.stringify({ itemId: emissionItemIds, inventoryId: 3 }),
                        QueueUrl: queueUrl2,
                        MessageGroupId: "INVENTORY_EXECUTE",
                        MessageDeduplicationId: uuidv4(),
                    };
                    const sqsResult2 = await extendedClient.sendMessage(params2);
                    if (!sqsResult2) {
                        console.error("SQS発行エラー 2-1");
                        throw new Error(204);
                    }
                    // ガチャ結果をSQSに
                    // LOOPガチャの場合在庫を減らす
                    if (gachaInfo.gachaLoopFlag) {
                        // 在庫を減らし、ガチャに在庫を追加する処理
                        const params3 = {
                            MessageBody: JSON.stringify({ itemId: emissionItemIds, inventoryId: 10 }),
                            QueueUrl: queueUrl2,
                            MessageGroupId: "INVENTORY_EXECUTE",
                            MessageDeduplicationId: uuidv4(),
                        };
                        const sqsResult3 = await extendedClient.sendMessage(params3);
                        if (!sqsResult3) {
                            console.error("SQS発行エラー 2-2");
                            throw new Error(204);
                        }
                    }
                    // ガチャのポジション更新 1
                    // await cluster.set("gacha:" + ENVID + ":" + gachaId + ":position", JSON.stringify([gachaId, emissionPosition]));
                    // ガチャを実行して0になった時、SystemRedisGachaを実行する
                    console.log("key = ", "gacha:" + gachaId + ":list")
                    // ガチャのポジション更新 2
                    // CSV用をSQSに
                    const params5 = {
                        MessageBody: JSON.stringify({
                            gachaId: gachaId,
                            userId: userId,
                            emissionIds: emissionIds,
                            executeAt: Math.floor(new Date().getTime() / 1000)
                        }),
                        QueueUrl: queueUrl4,
                        MessageGroupId: "EMISSION_EXECUTE",
                        MessageDeduplicationId: uuidv4(),
                    };
                    const sqsResult5 = await extendedClient.sendMessage(params5);
                    if (!sqsResult5) {
                        console.error("SQS発行エラー 4");
                        throw new Error(204);
                    }

                    const gachaLastRemainingCount = Number(await cluster.llen("gacha:" + ENVID + ":" + gachaId + ":list"));
                    if (gachaLastRemainingCount == 0) {
                        let invokeParams = {
                            FunctionName: "SystemRedisGachaExport-" + process.env.ENV,
                            InvocationType: "Event",
                        };
                        // invoke lambda
                        let result = await lambda.invoke(invokeParams).promise();

                        /* TATSU 20240129 ADD START Create history when remaining number is 0 */
                        // lambdaを起動 ガチャ履歴データ作成
                        let invokeParams1 = {
                            FunctionName: "InvokeOripaHistoryGenereateProcess-" + process.env.ENV,
                            InvocationType: "Event",
                            Payload: String(gachaId)
                        };
                        // invoke lambda
                        let result1 = await lambda.invoke(invokeParams1).promise();
                        if (result1.$response.error) throw (500, result1.$response.error.message);
                        /* TATSU 20240129 ADD END   Create history when remaining number is 0 */
                    }

                    // CSV用をSQSに
                    const params4 = {
                        MessageBody: JSON.stringify({
                            gachaId: gachaId,
                            userId: userId,
                            emissionIds: emissionIds,
                            startPoint: myPoint,
                            endPoint: Number(await cluster.get("user:" + ENVID + ":" + userId + ":pt")),
                            pattern: pattern,
                            executedAt: now
                        }),
                        QueueUrl: queueUrl3,
                        MessageGroupId: "ORIPA_EXECUTE",
                        MessageDeduplicationId: uuidv4(),
                    };
                    const sqsResult4 = await extendedClient.sendMessage(params4);
                    if (!sqsResult4) {
                        console.error("SQS発行エラー 3");
                        throw new Error(204);
                    }
                    return {
                        statusCode: 200,
                        headers: {
                            'Access-Control-Allow-Origin': '*',
                            'Access-Control-Allow-Headers': '*',
                        },
                        body: JSON.stringify({
                            // count: result.length,
                            // videoUrl: "https://productvideo-ogs-develop.s3.ap-northeast-1.amazonaws.com/001.mp4",
                            videoUrl: videoUrl,
                            videoKey: videoKey,
                            videoH265Path: process.env.VIDEOURLH265,
                            videoMp4Path: process.env.VIDEOURLMP4,
                            videoWebmPath: process.env.VIDEOURLWEBM,
                            prizeRarity: videoPriority,
                            startPoint: myPoint,
                            endPoint: Number(await cluster.get("user:" + ENVID + ":" + userId + ":pt")),
                            prizes: result,
                            packName: gachaInfo.gachaTranslateName,
                            count: execNum,
                            point: costPoint,
                        }),
                    }
                }
            }
            else {
                console.error("パラメーターが不正");
                throw new Error(102);
            }
        }
        // ログインしていない
        else {
            console.error("ログインしていない");
            throw new Error(101);
        }
    } catch (error) {
        // 自分がロックをかけた場合のみロック解除
        if (lockFlag) {
            await cluster.del("gacha:" + ENVID + ":" + gachaId + ":lock");
        }
        console.error(error);
        console.error("error1:", error.message);
        return {
            statusCode: 400,
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': '*',
            },
            body: JSON.stringify({
                errorCode: Number(error.message)
            }),
        }
    } finally {
        try {
            cluster.disconnect();
        }
        catch (e) {
            console.log("finally error", e);
        }
        if (mysql_con) await mysql_con.close();
    }
};