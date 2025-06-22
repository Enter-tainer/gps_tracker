/**
 * 文件浏览器组件
 * 负责显示文件列表和处理文件操作
 */
import { UI_ELEMENTS } from '../utils/constants.js';
import { getElement } from '../utils/helpers.js';

/**
 * 初始化文件浏览器组件
 * @param {Object} fileService - 文件服务
 * @param {Object} logger - 日志服务
 * @returns {Object} 文件浏览器接口
 */
export function initFileExplorer(fileService, logger) {
  const fileListDiv = getElement(UI_ELEMENTS.FILE_LIST_DIV);
  const currentPathInput = getElement(UI_ELEMENTS.CURRENT_PATH_INPUT);
  const listDirButton = getElement(UI_ELEMENTS.LIST_DIR_BUTTON);
  
  /**
   * 刷新当前目录
   */
  async function refreshCurrentDirectory() {
    try {
      const currentPath = currentPathInput ? currentPathInput.value : '/';
      await fileService.listDirectory(currentPath);
    } catch (error) {
      logger.error(`Error refreshing directory: ${error}`);
    }
  }
  
  /**
   * 导航到指定目录
   * @param {string} path - 目录路径
   */
  async function navigateTo(path) {
    try {
      await fileService.listDirectory(path);
    } catch (error) {
      logger.error(`Error navigating to ${path}: ${error}`);
    }
  }
  
  /**
   * 下载文件
   * @param {string} path - 文件路径
   * @param {string} name - 文件名
   * @param {number} size - 文件大小
   */
  async function downloadFile(path, name, size) {
    try {
      await fileService.downloadFile(path, name, size);
    } catch (error) {
      logger.error(`Error downloading file ${name}: ${error}`);
    }
  }
  
  /**
   * 预览GPX文件
   * @param {string} path - 文件路径
   * @param {string} name - 文件名
   * @param {number} size - 文件大小
   */
  async function previewGpx(path, name, size) {
    try {
      await fileService.downloadAndConvertToGpx(path, name, size, false);
    } catch (error) {
      logger.error(`Error previewing GPX file ${name}: ${error}`);
    }
  }
  
  /**
   * 下载GPX文件
   * @param {string} path - 文件路径
   * @param {string} name - 文件名
   * @param {number} size - 文件大小
   */
  async function downloadGpx(path, name, size) {
    try {
      await fileService.downloadAndConvertToGpx(path, name, size, true);
    } catch (error) {
      logger.error(`Error downloading GPX file ${name}: ${error}`);
    }
  }
  
  /**
   * 删除文件
   * @param {string} path - 文件路径
   * @param {string} name - 文件名
   */
  async function deleteFile(path, name) {
    if (!confirm(`Are you sure you want to delete file: ${name}?`)) return;
    if (!confirm(`Double check: Delete file "${name}"? This cannot be undone!`)) return;
    
    try {
      await fileService.deleteFile(path);
      logger.log(`File deleted: ${name}`);
      await refreshCurrentDirectory();
    } catch (error) {
      logger.error(`Error deleting file ${name}: ${error}`);
    }
  }
  
  // 返回文件浏览器接口
  return {
    refreshCurrentDirectory,
    navigateTo,
    downloadFile,
    previewGpx,
    downloadGpx,
    deleteFile
  };
}

export default initFileExplorer;