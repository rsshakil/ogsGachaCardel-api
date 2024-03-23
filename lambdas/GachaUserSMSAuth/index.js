/**
* @type {import('@types/aws-lambda').APIGatewayProxyHandler}
*/
const AWS = require("aws-sdk");
const mysql = require("mysql2/promise");
const ssm = new AWS.SSM();
const redis = require("ioredis");
const lambda = new AWS.Lambda();

process.env.TZ = "Asia/Tokyo";

const jwt = require("jsonwebtoken");
const jwtPattern = /^Bearer[ ]+([^ ]+)[ ]*$/i;
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
			Name: "PS_" + process.env.ENV,
			WithDecryption: true,
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
		process.env.ACCESS_TOKEN_SECRET = dbinfo.ACCESS_TOKEN_SECRET;
	}
	const ENVID = process.env.ENVID;
	// Database info
	const writeDbConfig = {
		host: process.env.DBWRITEENDPOINT,
		user: process.env.DBUSER,
		password: process.env.DBPASSWORD,
		database: process.env.DBDATABSE,
		charset: process.env.DBCHARSET,
	};
	const redisConfig = [
		{ host: process.env.REDISPOINT1, port: 6379 },
		{ host: process.env.REDISPOINT2, port: 6379 },
	];
	const cluster = new redis.Cluster(redisConfig, {
		dnsLookup: (address, callback) => callback(null, address),
		redisOptions: { tls: true },
	});
	let { smsToken } = JSON.parse(event.body);

	let mysql_con;
	let response = {};

	const nowUnixTimestamp = Math.floor(new Date().getTime() / 1000);

	try {
		// jwtからユーザーIDを取得
		const result = await getUserId();
		const { success, userId, statusCode } = result || {};
		if (!success)
		return getResponse({ message: "Unauthorize access" }, statusCode);
		// mysql connect
		mysql_con = await mysql.createConnection(writeDbConfig);

		const sourceIP = (event.requestContext.identity.sourceIp) ? event.requestContext.identity.sourceIp : '';
		console.log("sourceIP", sourceIP);

		// check & get target user info
		const read_sql = `SELECT userSMSToken, userSMSExpiredAt, userInvitationCode FROM User WHERE userId = ? AND userSMSToken = ? LIMIT 1`;

		const [read_query_result] = await mysql_con.execute(read_sql, [
			userId,
			smsToken,
		]);
        //getUserPhoneAndCountryCode
		const user_data_sql1 = `SELECT userSMSTelNoFormat, userSMSTelLanguageCCValue, userSMSExpiredAt FROM User WHERE userId = ? LIMIT 0, 1`;
		const [user_data_result1] = await mysql_con.query(user_data_sql1, [userId]);
		let phoneNumber = user_data_result1[0].userSMSTelNoFormat;
		let userSMSTelLanguageCCValue = user_data_result1[0].userSMSTelLanguageCCValue;
		let userSMSExpiredAt = user_data_result1[0].userSMSExpiredAt;

		const user_sms_insert_sql = `INSERT UserSmsHistory SET userSmsHistoryOtp = ?, userSmsHistoryExpiredAt = ?, userSmsHistoryUserId = ?, userSmsHistoryTellNo = ?, userSmsHistoryTellCountryCode = ?, userSmsHistoryType = ?, userSmsHistoryStatus = ?, userSmsHistoryIPAddress = ?, userSmsHistoryCreatedAt = ?`;
		//create sms failure history
		const userInfo = read_query_result[0];
		if ((read_query_result.length < 1) || (userInfo.userSMSExpiredAt < nowUnixTimestamp)) {
			await mysql_con.execute(user_sms_insert_sql, [smsToken, userSMSExpiredAt, userId, phoneNumber, userSMSTelLanguageCCValue, 4, 2, sourceIP, nowUnixTimestamp]);
		}

		if (read_query_result.length < 1) {
			// Not found sms token
			throw new Error(101);
		}

		if (userInfo.userSMSExpiredAt < nowUnixTimestamp) {
			// Token expired
			throw new Error(102);
		}

		// SMS認証登録作業
		const update_sql = `
			UPDATE
				User
			SET 
				userSMSToken = ?, 
				userSMSExpiredAt = ?,
				userSMSFlag = ?,
                userSMSAuthenticatedAt = ?,
				userUpdatedAt = ?
			WHERE userId = ?`;

		const sql_param = [
            null, 
            null, 
            1, 
            nowUnixTimestamp, 
            nowUnixTimestamp, 
            userId
        ];

		const [query_result] = await mysql_con.execute(update_sql, sql_param);

		//create sms success history
		await mysql_con.execute(user_sms_insert_sql, [smsToken, userSMSExpiredAt, userId, phoneNumber, userSMSTelLanguageCCValue, 4, 1, sourceIP, nowUnixTimestamp])

		// プレゼント処理
		// 1. 自身に紹介コードが存在する
		if (userInfo.userInvitationCode && userInfo.userInvitationCode != null) {
			console.log("紹介コードあり", userInfo.userInvitationCode);
			// プレゼント配布有効期限 2024/02/25 19:00:00まで
			if (nowUnixTimestamp <= 1708855200) {
				console.log("プレゼント配布期間内");
				// 強制配布
				let presentId = [5, 6, 7];
				// プレゼントが有効
				const presentSql = `SELECT * FROM Present WHERE presentId IN (5, 6, 7) AND presentStatus = 1`;
				const [present_query_result] = await mysql_con.execute(presentSql, presentId);
				console.log("check data", present_query_result);
				if (present_query_result && present_query_result.length >= 1) {
					console.log("有効プレゼントデータあり");
					// 2. 紹介者が存在していてSMS認証している状態
					const checkSql = `SELECT COUNT(userId) AS cnt FROM User WHERE userId = ? AND userSMSFlag = 1`;
					const [check_query_result] = await mysql_con.execute(checkSql, [userInfo.userInvitationCode]);
					if (check_query_result[0] && check_query_result[0].cnt >= 1) {
						console.log("紹介者が存在していてSMS認証している状態");
						// SMS認証済みで紹介者ベースでユーザー数を検索
						const countSql = `SELECT COUNT(userId) AS cnt FROM User WHERE userInvitationCode = ? AND userSMSFlag = 1`;
						const [check_query_result] = await mysql_con.execute(countSql, [userInfo.userInvitationCode]);
						if (check_query_result && check_query_result.length >= 1) {
							console.log("SMS認証済みで紹介者ベースでユーザー数", check_query_result[0].cnt);
							let invitacionUserCount = check_query_result[0].cnt;
							// 紹介人数が 1 ~ 3 の場合100pt付与
							if (invitacionUserCount >= 0 && invitacionUserCount < 4) {
								// 条件に合致したためプレゼントを配布
								// 期限を設定 今回は強制的に3日後の23:59:59
								let unix1 = nowUnixTimestamp + 259200;
								let unix1Date = new Date(unix1 * 1000);
								console.log("unix1Date", unix1Date);
								console.log("unix1Date.getFullYear()", unix1Date.getFullYear());
								console.log("unix1Date.getMonth()", unix1Date.getMonth());
								console.log("unix1Date.getDate()", unix1Date.getDate());
								let presentLimitDate = Math.floor(new Date( unix1Date.getFullYear(), unix1Date.getMonth(), unix1Date.getDate(), 23, 59, 59 ) / 1000);
								console.log("presentLimitDate", presentLimitDate);
								const insertQuery1 = `INSERT INTO UserPresent(userPresentUserId, userPresentPresentId, userPresentCreatedAt, userPresentExpiredAt) VALUES(?, ?, ?, ?)`;
								const [query_result1] = await mysql_con.execute(insertQuery1, [userInfo.userInvitationCode, 5, nowUnixTimestamp, presentLimitDate]);
								console.log("100pt配布");
							}
							// 紹介人数が 4 ~ 10 の場合30pt付与
							else if (invitacionUserCount >= 4 && invitacionUserCount < 11) {
								// 条件に合致したためプレゼントを配布
								// 期限を設定 今回は強制的に3日後の23:59:59
								let unix1 = nowUnixTimestamp + 259200;
								let unix1Date = new Date(unix1 * 1000);
								console.log("unix1Date", unix1Date);
								console.log("unix1Date.getFullYear()", unix1Date.getFullYear());
								console.log("unix1Date.getMonth()", unix1Date.getMonth());
								console.log("unix1Date.getDate()", unix1Date.getDate());
								let presentLimitDate = Math.floor(new Date( unix1Date.getFullYear(), unix1Date.getMonth(), unix1Date.getDate(), 23, 59, 59 ) / 1000);
								console.log("presentLimitDate", presentLimitDate);
								const insertQuery1 = `INSERT INTO UserPresent(userPresentUserId, userPresentPresentId, userPresentCreatedAt, userPresentExpiredAt) VALUES(?, ?, ?, ?)`;
								const [query_result1] = await mysql_con.execute(insertQuery1, [userInfo.userInvitationCode, 6, nowUnixTimestamp, presentLimitDate]);
								console.log("30pt配布");
							}
							// 紹介人数が 11 ~ 100 の場合1pt付与
							else if (invitacionUserCount >= 11 && invitacionUserCount < 100) {
								// 条件に合致したためプレゼントを配布
								// 期限を設定 今回は強制的に3日後の23:59:59
								let unix1 = nowUnixTimestamp + 259200;
								let unix1Date = new Date(unix1 * 1000);
								console.log("unix1Date", unix1Date);
								console.log("unix1Date.getFullYear()", unix1Date.getFullYear());
								console.log("unix1Date.getMonth()", unix1Date.getMonth());
								console.log("unix1Date.getDate()", unix1Date.getDate());
								let presentLimitDate = Math.floor(new Date( unix1Date.getFullYear(), unix1Date.getMonth(), unix1Date.getDate(), 23, 59, 59 ) / 1000);
								console.log("presentLimitDate", presentLimitDate);
								const insertQuery1 = `INSERT INTO UserPresent(userPresentUserId, userPresentPresentId, userPresentCreatedAt, userPresentExpiredAt) VALUES(?, ?, ?, ?)`;
								const [query_result1] = await mysql_con.execute(insertQuery1, [userInfo.userInvitationCode, 7, nowUnixTimestamp, presentLimitDate]);
								console.log("1pt配布");
							}
							// 紹介人数が 101 以上はポイント付与なし
							else {
								console.log("配布なし");
							}
						}
					}
				}
			}
		}
		response = {
			message: "success",
		};
		return getResponse(response, 200);
	} catch (error) {
		if (mysql_con) await mysql_con.rollback();
		console.error("error:", error);
		response = {
			errorCode: Number(error.message),
		};
		return getResponse(response, 400);
	} finally {
		if (mysql_con) await mysql_con.close();
	}

	function getResponse(data, statusCode = 200) {
		return {
			statusCode,
			headers: {
				"Access-Control-Allow-Origin": "*",
				"Access-Control-Allow-Headers": "*",
			},
			body: JSON.stringify(data),
		};
	}

	async function getUserId() {
		// ログインしている必要あり
		if (
			event.headers.Authorization &&
			event.headers.Authorization != null &&
			event.headers.Authorization != "Bearer null"
		) {
			// トークン
			const token = jwtPattern.exec(event.headers.Authorization)[1];
			console.log("token", token);
			const decoded = await jwt.verify(token, process.env.ACCESS_TOKEN_SECRET);
			if (decoded == null) {
				console.error("JWTが解析できない");
				return { success: false, statusCode: 103 };
			}
			console.log("decoded", decoded);
			let userId = decoded.userId;

			return { success: true, userId, statusCode: 200 };
		}
		// ログインしていない
		console.error("ログインしていない");
		return { success: false, statusCode: 101 };
	}
};
