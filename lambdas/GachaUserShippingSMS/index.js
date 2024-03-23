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
* GachaUsreSMS.
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

	// Database info
	const writeDbConfig = {
		host: process.env.DBWRITEENDPOINT,
		user: process.env.DBUSER,
		password: process.env.DBPASSWORD,
		database: process.env.DBDATABSE,
		charset: process.env.DBCHARSET
	};

	const ENVID = process.env.ENVID;

	const redisConfig = [
		{ host: process.env.REDISPOINT1, port: 6379 },
		{ host: process.env.REDISPOINT2, port: 6379 },
	];
	const cluster = new redis.Cluster(redisConfig, {
		dnsLookup: (address, callback) => callback(null, address),
		redisOptions: { tls: true },
	});

	let mysql_con;
	let response = {};
	const nowUnixTimestamp = Math.floor(new Date().getTime() / 1000);
	const expireDate = Math.floor(new Date().getTime() / 1000) + (10 * 60);

	let { userShippingId } = JSON.parse(event.body);

	try {
		// jwtからユーザーIDを取得
		const result = await getUserId();
		const { success, userId, statusCode } = result || {};
		if (!success) return getResponse({ message: "Unauthorize access" }, statusCode);
		// mysql connect
		mysql_con = await mysql.createConnection(writeDbConfig);


		// IP Block
		const checkDuplicateSql = `
			SELECT
				userSmsHistoryCreatedAt 
			FROM 
				UserSmsHistory 
			WHERE 
				userSmsHistoryIPAddress = ? 
			AND 
				userSmsHistoryType IN (1,2,3)
			AND 
				userSmsHistoryStatus = 1 
			ORDER BY 
				userSmsHistoryCreatedAt DESC
		`;
		const sourceIP = (event.requestContext.identity.sourceIp) ? event.requestContext.identity.sourceIp : '';
		const userAgent = event.requestContext.identity.userAgent;
		console.log("sourceIP", sourceIP);
		console.log("userAgent", userAgent);
		// blocklistのチェック, Here 1 means pattern type --> ipBlockPatternType
		const ipBlockKey = "ipblock:" + ENVID + ":2:list";
		const ipBlockConditionKey = "ipblock:" + ENVID + ":2:condition";
		const ipBlockPatternKey = `ipblockpattern:${ENVID}:2`;

		const ipBlockList = await cluster.zrange(ipBlockKey, nowUnixTimestamp, 9999999999, "BYSCORE");
		console.log("ipBlockList", ipBlockList);
		const conditionCount = ipBlockList.filter(member => (member == sourceIP));
		console.log("conditionCount", conditionCount.length);
		if (conditionCount.length >= 1) {
			console.error("重複登録エラー IPBlock", `${sourceIP}`);
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
		const [duplicatedQueryResult] = await mysql_con.execute(checkDuplicateSql, [sourceIP]);

		//sms historyCreate
		const user_sms_insert_sql = `INSERT UserSmsHistory SET userSmsHistoryOtp = ?, userSmsHistoryExpiredAt = ?, userSmsHistoryUserId = ?, userSmsHistoryTellNo = ?, userSmsHistoryTellCountryCode = ?, userSmsHistoryType = ?, userSmsHistoryStatus = ?, userSmsHistoryIPAddress = ?, userSmsHistoryCreatedAt = ?`;

		const sms_authentication_check_sql = `SELECT userSMSTelNoFormat, userSMSTelLanguageCCValue FROM User WHERE userId = ? AND userSMSFlag = 1 LIMIT 0, 1`;
		const [sms_authentication_check_data] = await mysql_con.query(sms_authentication_check_sql, [userId]);

		console.log('sms_authentication_check_data >>>>', sms_authentication_check_data)

		if (Array.isArray(sms_authentication_check_data) && sms_authentication_check_data.length > 0) {

			const { userSMSTelLanguageCCValue, userSMSTelNoFormat } = sms_authentication_check_data[0];

			//Send 6 digit OTP
			const generateOTP = () => Math.floor(100000 + Math.random() * 900000);
			const otp = generateOTP();
			console.log(otp);

			let smsBodyFromRedis = await cluster.get("system:" + ENVID + ":sab");
			let smsSenderSNS = await cluster.get("system:" + ENVID + ":ssn");

			let smsBodyAfterReplaceBody = smsBodyFromRedis.replaceAll("{%CODE%}", `${otp}`);

			// Remove specific characters such as (hyphens and brackets) using regular expressions
			// 数字のみにする
			let phoneNumber = userSMSTelNoFormat.replace(/\D/g, '');
			let phoneNumberWithCountryCode = userSMSTelLanguageCCValue + phoneNumber.toString();


			// データがない場合そのIPで初めての登録なのでスルー
			if (duplicatedQueryResult && duplicatedQueryResult.length >= 1) {
				console.log("checkDuplicateSql", duplicatedQueryResult);
				let errorFlag = false;
				console.log("nowUnixTimestamp", nowUnixTimestamp);

				const ipBlockPattern = await cluster.lrange(ipBlockPatternKey, 0, -1);

				for (let i = 0; i < ipBlockPattern.length; i++) {
					const pattern = JSON.parse(ipBlockPattern[i]);

					const conditionCount = duplicatedQueryResult.filter(row => row.userSmsHistoryCreatedAt >= nowUnixTimestamp - pattern.inquiryUnixtime);
					//console.log(`conditionCount${[i+1]}`, conditionCount);
					console.log(`conditionCount length ${[i + 1]}`, conditionCount.length);
					if (conditionCount.length >= pattern.maxCount) {
						console.error(`重複登録エラー 条件${[i + 1]}`, `${sourceIP}`);
						errorFlag = true;
						await cluster.zadd(ipBlockKey, nowUnixTimestamp + pattern.blockUnixtime, sourceIP);
						await cluster.zadd(ipBlockConditionKey, pattern.id, sourceIP);
						break;
					}
				}

				if (errorFlag) {
					// Insert SMS history
					await mysql_con.execute(user_sms_insert_sql, [otp, expireDate, userId, phoneNumber, userSMSTelLanguageCCValue, 3, 2, sourceIP, nowUnixTimestamp])

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


			// 発信元ID（Sender ID）を指定するためのMessageAttributes
			const messageAttributes = {
				'AWS.SNS.SMS.SenderID': {
					DataType: 'String',
					StringValue: smsSenderSNS
				}
			};

			// SMS setting
			let smsParams = {
				Message: smsBodyAfterReplaceBody,
				PhoneNumber: phoneNumberWithCountryCode,
				MessageAttributes: messageAttributes
			};
			let payload = JSON.stringify(smsParams);
			console.log(payload);
			let invokeParams = {
				FunctionName: "sendSMS-" + process.env.ENV,
				InvocationType: "Event",
				Payload: payload,
			};
			// invoke lambda
			let result = await lambda.invoke(invokeParams).promise();
			// console.log("==========result", result)
			if (result.$response.error) throw (500, result.$response.error.message);

			//Update DB
			const user_update_sql = `UPDATE User SET userShippingSMSToken = ?, userShippingSMSCheckExpiredAt = ? WHERE userId = ?`;
			await mysql_con.execute(user_update_sql, [otp, expireDate, userId])

			// Insert SMS history
			await mysql_con.execute(user_sms_insert_sql, [otp, expireDate, userId, phoneNumber, userSMSTelLanguageCCValue, 3, 1, sourceIP, nowUnixTimestamp])

			return getResponse({ message: "SMS Authenticated", errorCode: 200 }, 200);
		}

		throw new Error(403);

	} catch (error) {
		if (mysql_con) await mysql_con.rollback();
		console.error("error:", error);
		response = {
			errorCode: Number(error.message),
		};
		return getResponse(response, 400);
	} finally {
		if (mysql_con) await mysql_con.close();

		try {
			cluster.disconnect();
		}
		catch (e) {
			console.log("finally error", e);
		}
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
