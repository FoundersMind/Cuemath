from django.contrib import admin
from django.urls import include, path

urlpatterns = [
    path("admin/", admin.site.urls),
    path("recruiter/", include("api.recruiter_urls")),
    path("api/", include("api.urls")),
    path("", include("api.front_urls")),
]
