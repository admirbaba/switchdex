import { assetDataUtils, BigNumber } from '0x.js';
import { SignedOrder } from '@0x/connect';

import { getLogger } from '../util/logger';
import { getTransactionOptions } from '../util/transactions';
import { Token } from '../util/types';
import { ordersToIEOUIOrders, ordersToUIOrders } from '../util/ui_orders';

import { getContractWrappers } from './contract_wrappers';
import { getRelayer, getUserIEOSignedOrders } from './relayer';
import { getWeb3Wrapper } from './web3_wrapper';

const logger = getLogger('Services::Orders');

export const getAllOrders = (baseToken: Token, quoteToken: Token) => {
    const relayer = getRelayer();
    const baseTokenAssetData = assetDataUtils.encodeERC20AssetData(baseToken.address);
    const quoteTokenAssetData = assetDataUtils.encodeERC20AssetData(quoteToken.address);
    return relayer.getAllOrdersAsync(baseTokenAssetData, quoteTokenAssetData);
};

export const getAllOrdersAsUIOrders = async (baseToken: Token, quoteToken: Token) => {
    const orders: SignedOrder[] = await getAllOrders(baseToken, quoteToken);
    try {
        const contractWrappers = await getContractWrappers();
        const ordersAndTradersInfo = await contractWrappers.orderValidator.getOrdersAndTradersInfoAsync(
            orders,
            orders.map(o => o.makerAddress),
        );
        return ordersToUIOrders(orders, baseToken, ordersAndTradersInfo);
    } catch (err) {
        logger.error(`There was an error getting the orders' info from exchange.`, err);
        throw err;
    }
};

export const getAllOrdersAsUIOrdersWithoutOrdersInfo = async (baseToken: Token, quoteToken: Token) => {
    const orders: SignedOrder[] = await getAllOrders(baseToken, quoteToken);
    return ordersToUIOrders(orders, baseToken);
};

export const getUserOrders = (baseToken: Token, quoteToken: Token, ethAccount: string) => {
    const relayer = getRelayer();
    const baseTokenAssetData = assetDataUtils.encodeERC20AssetData(baseToken.address);
    const quoteTokenAssetData = assetDataUtils.encodeERC20AssetData(quoteToken.address);
    return relayer.getUserOrdersAsync(ethAccount, baseTokenAssetData, quoteTokenAssetData);
};

export const getUserOrdersAsUIOrders = async (baseToken: Token, quoteToken: Token, ethAccount: string) => {
    const myOrders = await getUserOrders(baseToken, quoteToken, ethAccount);
    try {
        const contractWrappers = await getContractWrappers();
        const ordersAndTradersInfo = await contractWrappers.orderValidator.getOrdersAndTradersInfoAsync(
            myOrders,
            myOrders.map(o => o.makerAddress),
        );
        return ordersToUIOrders(myOrders, baseToken, ordersAndTradersInfo);
    } catch (err) {
        logger.error(`There was an error getting the orders' info from exchange.`, err);
        throw err;
    }
};

export const cancelSignedOrder = async (order: SignedOrder, gasPrice: BigNumber) => {
    const contractWrappers = await getContractWrappers();
    const web3Wrapper = await getWeb3Wrapper();
    const tx = await contractWrappers.exchange.cancelOrderAsync(order, getTransactionOptions(gasPrice));
    return web3Wrapper.awaitTransactionSuccessAsync(tx);
};

export const getUserIEOOrdersAsUIOrders = async (baseToken: Token, quoteToken: Token, ethAccount: string) => {
    const myOrders = await getUserIEOSignedOrders(ethAccount, baseToken, quoteToken);
    try {
        const contractWrappers = await getContractWrappers();
        const ordersAndTradersInfo = await contractWrappers.orderValidator.getOrdersAndTradersInfoAsync(
            myOrders,
            myOrders.map(o => o.makerAddress),
        );
        return ordersToIEOUIOrders(myOrders, baseToken, ordersAndTradersInfo);
    } catch (err) {
        logger.error(`There was an error getting the ieo orders info from exchange.`, err);
        throw err;
    }
};
