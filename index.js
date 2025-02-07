const _ = require("lodash");
const { HttpLink } = require("apollo-link-http");
const { ApolloClient } = require("apollo-client");
const { InMemoryCache } = require("apollo-cache-inmemory");
const {
  utils,
  constants,
  providers,
  BigNumber,
  Wallet,
  Contract,
} = require("ethers");

const { usersQuery } = require("./query.js");

const config = require("./config.json");
const PoolAbi = require("./abis/Pool.json");
const MTokenAbi = require("./abis/MToken.json");
const OracleAbi = require("./abis/OracleAbi.json");
const MulticallAbi = require("./abis/MulticallAbi.json");
const LiquidationAbi = require("./abis/Liquidation.json");

const provider = new providers.JsonRpcProvider(config.rpc_url);

// interfaces
const poolInterface = new utils.Interface(PoolAbi);
const mTokenInterface = new utils.Interface(MTokenAbi);

const multicallContract = new Contract(
  config.contracts.multicall,
  MulticallAbi,
  provider
);

const apolloFetcher = async (query) => {
  const client = new ApolloClient({
    link: new HttpLink({
      uri: config.subgraph_url,
    }),
    cache: new InMemoryCache(),
  });

  return client.query({
    query: query,
    fetchPolicy: "cache-first",
  });
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// exports.handler = async (event) => {
async function main() {
  // 1. fetch users with AccountData
  const accountsInfo = await apolloFetcher(usersQuery);
  const { users } = accountsInfo.data;

  let usersHealthReq = [];
  config.pools.map((pool) => {
    users.map((user) => {
      usersHealthReq.push({
        target: pool,
        callData: poolInterface.encodeFunctionData("getUserAccountData", [
          user.id,
        ]),
      });
    });
  });
  const usersHealthRes = await multicallContract.callStatic.aggregate(
    usersHealthReq
  );

  // 2. generate unhealthy users
  const unhealthyUsers = usersHealthRes[1]
    .map((userHealth, ind) => {
      const detailedInfo = poolInterface.decodeFunctionResult(
        "getUserAccountData",
        userHealth
      );

      const userInd = ind % users.length;
      const poolInd = Math.floor(ind / users.length);
      return {
        user: users[userInd].id,
        pool: config.pools[poolInd],
        healthy: BigNumber.from(detailedInfo.healthFactor),
      };
    })
    .filter(
      (userHealth) =>
        userHealth.healthy.lt(constants.WeiPerEther) && userHealth.healthy.gt(0)
    );
  console.log(unhealthyUsers);

  // 3. fetch unhealthy users debt info
  const liquidator = new Wallet(config.liquidator_key, provider);
  for (const unhealthyUser of unhealthyUsers) {
    let collateralAsset = "";
    let debtAsset = "";

    const botInfo = config.bots[unhealthyUser.pool];
    let mTokenRequest = [];
    botInfo.mTokens.map((mToken) => {
      mTokenRequest.push({
        target: mToken,
        callData: mTokenInterface.encodeFunctionData("balanceOf", [
          unhealthyUser.user,
        ]),
      });

      mTokenRequest.push({
        target: mToken,
        callData: mTokenInterface.encodeFunctionData(
          "UNDERLYING_ASSET_ADDRESS",
          []
        ),
      });
    });

    botInfo.dTokens.map((dToken) => {
      mTokenRequest.push({
        target: dToken,
        callData: mTokenInterface.encodeFunctionData("balanceOf", [
          unhealthyUser.user,
        ]),
      });

      mTokenRequest.push({
        target: dToken,
        callData: mTokenInterface.encodeFunctionData(
          "UNDERLYING_ASSET_ADDRESS",
          []
        ),
      });
    });
    const tokenRes = await multicallContract.callStatic.aggregate(
      mTokenRequest
    );

    let mInfos = [];
    let dInfos = [];
    const tokenInfos = tokenRes[1].map((tokenRes, ind) => ({
      info: mTokenInterface.decodeFunctionResult(
        ind % 2 == 0 ? "balanceOf" : "UNDERLYING_ASSET_ADDRESS",
        tokenRes
      ),
    }));
    for (let ii = 0; ii < tokenInfos.length - 1; ii++) {
      const selInd = ii % 2;
      if (selInd == 0) {
        const detailedInfo = tokenInfos[ii].info[0];
        if (detailedInfo.gt(0)) {
          if (ii < botInfo.mTokens.length * 2) {
            mInfos.push({
              mtoken: botInfo.mTokens[Math.floor(ii / 2)],
              token: tokenInfos[ii + 1].info,
              amount: BigNumber.from(detailedInfo),
            });
          } else {
            dInfos.push({
              token: tokenInfos[ii + 1].info,
              amount: BigNumber.from(detailedInfo),
            });
          }
        }
      }
    }

    // console.log(mInfos, dInfos, unhealthyUser.user);
    if (mInfos.length > 0 && dInfos.length > 0) {
      collateralAsset = mInfos[0].token[0];
      debtAsset = dInfos[0].token[0];

      const collateralContract = new Contract(
        collateralAsset,
        MTokenAbi,
        provider
      );
      const collBal = await collateralContract.balanceOf(mInfos[0].mtoken);
      const calBal = dInfos[0].amount.mul(1100).div(1e3);
      const checkedBal = calBal > collBal ? collBal : calBal;
      const cover = calBal > collBal ? collBal : constants.MaxUint256;

      const botContract = new Contract(
        config.bots[unhealthyUser.pool].bot,
        LiquidationAbi,
        provider
      );
      const lParam = {
        collateralAsset,
        debtAsset,
        user: unhealthyUser.user,
        amount: checkedBal,
        transferAmount: 0,
        debtToCover: cover,
      };
      const sParam = {
        receiver: liquidator.address,
        swapRouter: config.contracts.router,
        path1: [collateralAsset, debtAsset],
        path2: [debtAsset, config.contracts.wflow],
      };
      console.log(lParam, sParam);

      const tx = await botContract.connect(liquidator).execute(lParam, sParam);
      await tx.wait();
      await sleep(3000);
    }
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exit();
  })
  .finally(() => {
    console.log("finally");
    process.exit();
  });
