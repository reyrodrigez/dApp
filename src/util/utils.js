const BUY_SIGN = 1;
const SELL_SIGN = -1;

/**
 * Signs a message.
 *
 * @param web3
 * @param address
 * @param message
 * @return {[*,*,*]}
 */
export const signMessage = function(web3, address, message) {
  const signature = web3.eth.sign(address, message);
  const r = signature.slice(0, 66);
  const s = `0x${signature.slice(66, 130)}`;
  let v = web3.toDecimal(`0x${signature.slice(130, 132)}`);
  if (v !== 27 && v !== 28) v += 27;
  return [v, r, s];
};

/**
 *
 * @param priceFloor
 * @param priceCap
 * @param qtyMultiplier
 * @param qty
 * @param price
 * @return {number}
 */
export const calculateCollateral = function(
  priceFloor,
  priceCap,
  qtyMultiplier,
  qty,
  price
) {
  const zero = 0;
  let maxLoss;
  if (qty > zero) {
    if (price <= priceFloor) {
      maxLoss = zero;
    } else {
      maxLoss = price - priceFloor;
    }
  } else {
    if (price >= priceCap) {
      maxLoss = zero;
    } else {
      maxLoss = priceCap - price;
    }
  }
  return maxLoss * Math.abs(qty) * qtyMultiplier;
};

// TODO: move me to wherever I belong -clean up, add documentation, figure out how best to create order object in JS
export async function getBids(web3, marketContract, orderLib) {
  // for now we will create orders around the contract mid price, eventually we should create orders
  // that are around an price pulled from an active API that mimics the oracle solution
  const contractMidPrice =
    (marketContract.PRICE_FLOOR.call().toNumber() +
      marketContract.PRICE_CAP.call().toNumber()) /
    2;

  // we will need to fix this, the server will need to have an unlocked account created the order for the user to match
  // here we are just using an account that we only have access to in the dev environment, but wont be able
  // to use when we attempt to deploy to a test net (rinkeby)
  return createNewOrders(
    web3,
    marketContract,
    orderLib,
    web3.eth.accounts[0],
    contractMidPrice - BUY_SIGN, // subtract our sign so our market are not crossed.
    SELL_SIGN,
    5
  );
}

export async function getAsks(web3, marketContract, orderLib) {
  // for now we will create orders around the contract mid price, eventually we should create orders
  // that are around an price pulled from an active API that mimics the oracle solution
  const contractMidPrice =
    (marketContract.PRICE_FLOOR.call().toNumber() +
      marketContract.PRICE_CAP.call().toNumber()) /
    2;

  // we will need to fix this, the server will need to have an unlocked account created the order for the user to match
  // here we are just using an account that we only have access to in the dev environment, but wont be able
  // to use when we attempt to deploy to a test net (rinkeby)
  return createNewOrders(
    web3,
    marketContract,
    orderLib,
    web3.eth.accounts[0],
    contractMidPrice - BUY_SIGN, // subtract our sign so our market are not crossed.
    SELL_SIGN,
    5
  );
}

const createNewOrders = async function(
  web3,
  marketContract,
  orderLib,
  makerAccount,
  startingPrice,
  mktSign,
  desiredOrderCount
) {
  if (desiredOrderCount <= 0) return null;

  startingPrice = Math.trunc(startingPrice); //convert to integer
  const orders = [];
  const orderQty = 1 * mktSign; // for now all orders have qty of 1 (+1 for bid, -1 for sell)
  const expirationTimeStamp = Math.floor(Date.now() / 1000) + 86400; // order expires in a day.
  const takerAccount = null;
  const feeRecipient = null;
  const makerFee = 0;
  const takerFee = 0;

  for (let i = 0; i < desiredOrderCount; i++) {
    const newOrderPrice = startingPrice - i * mktSign;
    const order = new Order(
      marketContract.address,
      makerAccount,
      takerAccount,
      feeRecipient,
      makerFee,
      takerFee,
      newOrderPrice,
      expirationTimeStamp,
      1,
      orderQty
    );
    await order.getOrderHash(orderLib);
    order.signOrder(web3, makerAccount);
    orders.push(order);
  }

  return orders;
};

// TODO(perfectmak): This should be moves to a more cohesive helper package
export async function processContractsList(
  marketContract,
  marketCollateralPool,
  collateralToken,
  ERC20,
  deployedContracts
) {
  let promises = deployedContracts.map(async contract => {
    return await marketContract
      .at(contract)
      .then(async function(instance) {
        const contractJSON = {};
        contractJSON['key'] = instance.address;
        contractJSON['CONTRACT_NAME'] = await instance.CONTRACT_NAME.call();

        const collateralTokenContractAddress = await instance.COLLATERAL_TOKEN_ADDRESS.call();
        contractJSON[
          'COLLATERAL_TOKEN_ADDRESS'
        ] = collateralTokenContractAddress;

        await collateralToken
          .at(collateralTokenContractAddress)
          .then(async function(collateralTokenInstance) {
            contractJSON[
              'COLLATERAL_TOKEN'
            ] = await collateralTokenInstance.name();
            contractJSON[
              'COLLATERAL_TOKEN_SYMBOL'
            ] = await collateralTokenInstance.symbol();
          })
          .catch(function(err) {
            try {
              const token = contract(ERC20).at(collateralTokenContractAddress);
              contractJSON['COLLATERAL_TOKEN'] = token.name();
              contractJSON['COLLATERAL_TOKEN_SYMBOL'] = token.symbol();
            } catch (e) {
              console.error(e);
              contractJSON['COLLATERAL_TOKEN'] = 'NA';
              contractJSON['COLLATERAL_TOKEN_SYMBOL'] = 'NA';
            }
          });

        contractJSON['PRICE_FLOOR'] = await instance.PRICE_FLOOR.call().then(
          data => data.toNumber()
        );
        contractJSON['PRICE_CAP'] = await instance.PRICE_CAP.call().then(data =>
          data.toNumber()
        );
        contractJSON[
          'PRICE_DECIMAL_PLACES'
        ] = await instance.PRICE_DECIMAL_PLACES.call().then(data =>
          data.toNumber()
        );
        contractJSON[
          'QTY_MULTIPLIER'
        ] = await instance.QTY_MULTIPLIER.call().then(data => data.toNumber());
        contractJSON['ORACLE_QUERY'] = await instance.ORACLE_QUERY.call();
        contractJSON['EXPIRATION'] = await instance.EXPIRATION.call().then(
          data => data.toNumber()
        );
        contractJSON['lastPrice'] = await instance.lastPrice
          .call()
          .then(data => data.toNumber());
        contractJSON['isSettled'] = await instance.isSettled.call();

        // TODO: There is a possibility a contract ends up in our registry that wasn't linked to a collateral pool
        // correctly.  The code below will handle this, but a better solution would probably to not actually
        // display contracts that are not correctly linked to a collateral pool!
        await marketCollateralPool
          .at(await instance.MARKET_COLLATERAL_POOL_ADDRESS.call())
          .then(async function(collateralPoolInstance) {
            contractJSON[
              'collateralPoolBalance'
            ] = await collateralPoolInstance.collateralPoolBalance
              .call()
              .then(data => data.toNumber());
          })
          .catch(function(err) {
            console.error(err);
            contractJSON['collateralPoolBalance'] = 'NA';
          });

        return contractJSON;
      })
      .catch(function(err) {
        console.error(err);
      });
  });

  return await Promise.all(promises);
}

class Order {
  constructor(
    contractAddress,
    maker,
    taker,
    feeRecipient,
    makerFee,
    takerFee,
    price,
    expirationTimeStamp,
    salt,
    orderQty
  ) {
    this.contractAddress = contractAddress;
    this.maker = maker;
    this.taker = taker;
    this.feeRecipient = feeRecipient;
    this.makerFee = makerFee;
    this.takerFee = takerFee;
    this.price = price;
    this.expirationTimeStamp = expirationTimeStamp;
    this.salt = salt;
    this.orderQty = orderQty;
    this.remainingQty = orderQty;
    this.orderHash = null;
    this.orderAddresses = [maker, taker, feeRecipient];
    this.unsignedOrderValues = [
      makerFee,
      takerFee,
      price,
      expirationTimeStamp,
      salt
    ];
    this.v = null;
    this.r = null;
    this.s = null;
    this.isSigned = false;
  }

  async getOrderHash(orderLib) {
    if (this.orderHash != null) return this.orderHash;

    this.orderHash = await orderLib.createOrderHash.call(
      this.contractAddress,
      this.orderAddresses,
      this.unsignedOrderValues,
      this.orderQty
    );

    return this.orderHash;
  }

  signOrder(web3, makerAccount) {
    if (this.isSigned) return;

    const signature = signMessage(web3, makerAccount, this.orderHash);
    this.v = signature[0];
    this.r = signature[1];
    this.s = signature[2];
    this.isSigned = true;
  }
}

/**
 * Convert MetaMask error message to dApp error message.
 * Fallback: return original message.
 *
 * @param errorMessage
 * @return getMetamaskError
 */
export const getMetamaskError = function(message) {
  if (message.indexOf('User denied transaction') !== -1)
    return 'User denied transaction';
  else return message;
};

export const getLocationOrigin = () => window.location.origin;

/**
 * Detect if network belongs to testnet/mainnet
 *
 * @param network
 * @return boolean true/false
 */
export const isTestnetOrMainnet = network => {
  return (
    network !== 'truffle' && network !== 'ganache' && network !== 'unknown'
  );
};

/**
 * Set `collateralTokenAddress` based on the `network`
 *
 * `0x01b8de20c76ed06c7e93068a45951c26f70be3db` -- WETH
 * `0x0c58e89866dda96911a78dedf069a1848618c185` -- Stable USD
 *
 * @param network
 * @return collateralTokenAddress
 *
 * TODO: Update the method to return `WUSD` if the selected symbol pair is USD
 */
export const getCollateralTokenAddress = (network, quoteAsset) => {
  if (network === 'rinkeby') {
    switch (quoteAsset) {
      case 'ETH':
        return '0x01b8de20c76ed06c7e93068a45951c26f70be3db';
      case 'USDT':
        return '0x0c58e89866dda96911a78dedf069a1848618c185';
      default:
        return '';
    }
  }
  return '';
};
