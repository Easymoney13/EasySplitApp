function isRestaurantDataAdmin(user) {
  return Boolean(user && (user.admin === true || user.restaurantDataAdmin === true));
}

function requireRestaurantDataAdmin(req, res, nextMiddleware) {
  if (!req.user) return res.status(401).json({ error: 'Authentication required' });
  if (!isRestaurantDataAdmin(req.user)) {
    return res.status(403).json({ error: 'Restaurant data administrator access is required' });
  }
  return nextMiddleware();
}

module.exports = {
  isRestaurantDataAdmin,
  requireRestaurantDataAdmin,
};
