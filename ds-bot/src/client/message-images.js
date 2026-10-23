export function messageImageRenderer({ renderMessageImages, renderFactorySlot, loadImage }) {
  if (typeof renderMessageImages === 'function') return renderMessageImages
  if (typeof renderFactorySlot === 'function' && typeof loadImage === 'function') {
    return owner => renderFactorySlot('conversation.images.content', { ...owner, loadImage })
  }
  return undefined
}
